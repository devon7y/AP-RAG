import { geolocation, ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  type ModelMessage,
  streamText,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { retrieve } from "@/lib/aprag/client";
import { buildContext, SYNTH_SYSTEM_PROMPT } from "@/lib/aprag/citations";
import { condenseAndExtract, type HistoryTurn } from "@/lib/aprag/condense";
import { dropDismissed, mergeFilters } from "@/lib/aprag/filters";
import type { RagRetrieval } from "@/lib/aprag/types";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type { ChatMessage } from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 300;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

// The conversation as plain text turns, for the retrieval-query condense step.
function toHistoryTurns(messages: ChatMessage[]): HistoryTurn[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: getTextFromMessage(m),
    }))
    .filter((t) => t.content.trim().length > 0);
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const {
      id,
      message,
      messages,
      selectedVisibilityType,
      reasoning = "none",
      mode,
      chunkMode = false,
      filters,
      dismissed,
    } = requestBody;

    const [, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    // AP-RAG has no tools, so the template's tool-approval continuation (`messages`)
    // never fires; every turn carries a single user `message`.
    if (!message || message.role !== "user") {
      return new ChatbotError("bad_request:api").toResponse();
    }
    void messages;

    await checkIpRateLimit(ipAddress(request));

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 1,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    const uiMessages: ChatMessage[] = [
      ...convertToUIMessages(messagesFromDb),
      message as ChatMessage,
    ];

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    // The latest user question + the prior conversation (for condensing/synthesis).
    const question = getTextFromMessage(message as ChatMessage);
    const priorMessages = uiMessages.slice(0, -1);
    const retrievalMode = mode ?? (chunkMode ? "naive" : "hybrid");

    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer: dataStream }) => {
        // 1. Condense into a standalone query AND run the second-pass LLM filter
        //    extraction (catches mistyped/fuzzy names the client preview misses).
        const { query: retrievalQuery, filters: inferred } =
          await condenseAndExtract(toHistoryTurns(priorMessages), question);

        // Honor the user's pre-send cancellations, then combine the client-confirmed
        // filters with the server's second-pass extraction.
        const inferredKept = dropDismissed(inferred, dismissed ?? []);
        const effectiveFilters = mergeFilters(filters ?? null, inferredKept);

        // 2. Retrieve from the AP-RAG query server (PC, over the tunnel).
        const retrieved = await retrieve({
          question: retrievalQuery,
          mode: retrievalMode,
          filters: effectiveFilters,
        });

        // 3. Build the synthesis context first (answer mode) — this stamps a per-passage
        //    citeIndex onto each chunk, which must be present BEFORE we serialize the
        //    chunks into the data part below.
        const context = chunkMode
          ? ""
          : buildContext(retrieved.references, retrieved.chunks);

        // 4. Attach the retrieval payload to the assistant message (persisted, so the
        //    UI re-renders references / inline citations / chunk cards on reload).
        const ragRetrieval: RagRetrieval = {
          query: retrievalQuery,
          mode: retrieved.mode,
          chunkMode,
          references: retrieved.references,
          chunks: retrieved.chunks,
          entities: retrieved.entities,
          relationships: retrieved.relationships,
          appliedFilters: effectiveFilters,
        };
        dataStream.write({
          type: "data-retrieval",
          id: generateUUID(),
          data: ragRetrieval,
        });

        // 4a. Chunk mode: no synthesis — the UI renders the raw chunk cards.
        if (chunkMode) {
          return;
        }

        // 4b. Answer mode: synthesize with gpt-5.4-mini, streamed, citing passage [n].
        // Only carry text-bearing turns into history (a prior chunk-mode turn has just a
        // data part — convertToModelMessages would otherwise produce an empty message).
        const priorForSynthesis = priorMessages.filter((m) =>
          m.parts?.some(
            (p) => p.type === "text" && (p as { text?: string }).text?.trim()
          )
        );
        const priorModelMessages =
          await convertToModelMessages(priorForSynthesis);
        const synthesisMessages: ModelMessage[] = [
          ...priorModelMessages,
          {
            role: "user",
            content: `${question}\n\n${context}`,
          },
        ];

        const result = streamText({
          model: getLanguageModel(DEFAULT_CHAT_MODEL),
          system: SYNTH_SYSTEM_PROMPT,
          messages: synthesisMessages,
          providerOptions: {
            openai: { reasoningEffort: reasoning },
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
        });

        dataStream.merge(result.toUIMessageStream({ sendReasoning: true }));

        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ type: "data-chat-title", data: title });
            updateChatTitleById({ chatId: id, title });
          } catch (_) {
            /* non-fatal */
          }
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
        // In chunk mode the title write above is skipped; persist the title here.
        if (chunkMode && titlePromise) {
          try {
            const title = await titlePromise;
            await updateChatTitleById({ chatId: id, title });
          } catch (_) {
            /* non-fatal */
          }
        }
        if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              id: currentMessage.id,
              role: currentMessage.role,
              parts: currentMessage.parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            })),
          });
        }
      },
      onError: () => "Oops, an error occurred while retrieving from AP-RAG!",
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          /* non-critical */
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
