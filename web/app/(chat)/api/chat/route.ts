import { ipAddress } from "@vercel/functions";
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
import {
  DEFAULT_CHAT_MODEL,
  openaiOptions,
  SYNTH_VERBOSITY,
} from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { buildContext, SYNTH_SYSTEM_PROMPT } from "@/lib/aprag/citations";
import { getStats, type RetrieveResult, retrieve } from "@/lib/aprag/client";
import { condenseAndExtract, type HistoryTurn } from "@/lib/aprag/condense";
import {
  type BucketRetrieval,
  bucketize,
  bucketTopK,
  buildDigestContext,
  buildDigestSystemPrompt,
  chooseBucketUnit,
  type DigestConfig,
  mapLimit,
  mergeBucketRetrievals,
  ymNow,
} from "@/lib/aprag/digest";
import {
  DIGEST_WINDOW_DISMISS_KEY,
  dropDismissed,
  mergeFilters,
} from "@/lib/aprag/filters";
import {
  buildPersonaContext,
  buildPersonaSystemPrompt,
} from "@/lib/aprag/persona";
import {
  buildPinnedContext,
  buildPinnedSystemPrompt,
  mergePinnedRetrievals,
  type PinnedRetrieval,
} from "@/lib/aprag/pinned";
import type { RagRetrieval } from "@/lib/aprag/types";
import {
  buildUploadContext,
  describeUploads,
  maxCiteIndex,
  selectUploadPassages,
  UPLOAD_SOURCE_NOTE,
  type UploadedPaper,
} from "@/lib/aprag/uploads";
import { isProductionEnvironment } from "@/lib/constants";
import {
  claimChatTurn,
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getUploadedPapersForChat,
  releaseChatTurn,
  resolveChatAccess,
  saveChat,
  saveMessages,
  setChatActiveStream,
  setChatTyping,
  updateChatDigest,
  updateChatTitleById,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import { hasRedis } from "@/lib/redis";
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

  // Tracked out here so a throw between claiming the turn and finishing the stream still
  // releases it, rather than leaving the chat wedged until the staleness window expires.
  let claimedTurn: { chatId: string; userId: string } | null = null;

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
      personaAuthor,
      digest,
      digestRefresh,
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

    // "Talk to Author": an existing chat's author comes from its row; a brand-new author
    // chat carries it in the body's `personaAuthor` on the first message. When set, the
    // synthesis below runs the author-persona path (forced author filter + persona prompt).
    const persona: string | null = chat
      ? (chat.personaAuthor ?? null)
      : personaAuthor?.trim() || null;

    // "Research Digest": like persona, an existing chat's config comes from its row; a
    // brand-new digest chat carries {topic, from, to} in the body on the first message.
    // We stamp the bucket unit (month vs year) from the span at creation time.
    const digestConfig: DigestConfig | null = chat
      ? ((chat.digest as DigestConfig | null) ?? null)
      : digest
        ? { ...digest, bucket: chooseBucketUnit(digest.from, digest.to) }
        : null;

    if (chat) {
      // Owner, an invited member, or (on a public chat) any signed-in user. Everyone who
      // can read a shared chat can post into it.
      const access = await resolveChatAccess({
        chatId: id,
        userId: session.user.id,
      });
      if (!access?.canWrite) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      const label = persona ?? (digestConfig ? "Digest" : null);
      await saveChat({
        id,
        userId: session.user.id,
        title: label ? `(${label})` : "New chat",
        visibility: selectedVisibilityType,
        personaAuthor: persona,
        digest: digestConfig,
      });
      // Author/digest chats get an auto topic title like normal chats, prefixed with the
      // label — e.g. "(Westbury) Language and Humor", "(Digest) LLM agents" — so history reads clearly.
      const rawTitlePromise = generateTitleFromUserMessage({ message });
      titlePromise = label
        ? rawTitlePromise.then((t) => `(${label}) ${t}`)
        : rawTitlePromise;
    }

    // A chat answers one question at a time. Two participants sending at once would
    // interleave their retrievals and race the message inserts (which are ordered by
    // createdAt alone), so the sender claims the chat for the duration of the turn. The
    // claim is one conditional UPDATE, so exactly one of two simultaneous senders wins;
    // the loser gets a 409 and their composer shows who is currently asking.
    const turnClaimed = await claimChatTurn({
      chatId: id,
      userId: session.user.id,
    });
    if (!turnClaimed) {
      return new ChatbotError("conflict:chat").toResponse();
    }
    claimedTurn = { chatId: id, userId: session.user.id };

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
            // Attribution: in a shared chat the transcript labels who asked what.
            userId: session.user.id,
          },
        ],
      });
      // The question is sent, so this composer is no longer "typing". The client clears
      // this too when its box empties; doing it here means the indicator can't linger if
      // that request is lost.
      await setChatTyping({
        chatId: id,
        userId: session.user.id,
        typing: false,
      });
    }

    // The latest user question + the prior conversation (for condensing/synthesis).
    const question = getTextFromMessage(message as ChatMessage);
    const priorMessages = uiMessages.slice(0, -1);
    // "auto" (the default) lets the condense LLM pick the strategy below.
    const requestedMode = mode ?? "auto";

    // "Update" on an open-ended digest: re-run the digest generation over the window
    // extended to now (appending a fresh digest message to the chat). Only meaningful
    // on an existing chat whose digest tracks the present.
    const digestRefreshRequested = Boolean(
      digestRefresh && chat && digestConfig?.openEnded
    );

    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer: dataStream }) => {
        // Research Digest, FIRST message (or an "Update" run): split the date range into
        // time buckets, retrieve each independently with a date-window filter, stitch
        // into one chronological context (global [n] cites), and synthesize dated ###
        // sections. Other follow-up turns fall through to the normal flow below (with
        // the window applied as a filter).
        if (
          digestConfig &&
          (priorMessages.length === 0 || digestRefreshRequested)
        ) {
          // An open-ended digest always runs up to the current month; a fixed window
          // keeps its stored end.
          const runTo = digestConfig.openEnded ? ymNow() : digestConfig.to;
          const runConfig: DigestConfig = {
            ...digestConfig,
            to: runTo,
            bucket: chooseBucketUnit(digestConfig.from, runTo),
          };
          const buckets = bucketize(runConfig.from, runConfig.to);
          const topK = bucketTopK(buckets.length);
          const bucketResults: BucketRetrieval[] = await mapLimit(
            buckets,
            4,
            async (b) => {
              try {
                const result = await retrieve({
                  question: digestConfig.topic,
                  mode: "hybrid",
                  filters: { date_from: b.from, date_to: b.to },
                  chunkTopK: topK,
                });
                return { bucket: b, result };
              } catch {
                return {
                  bucket: b,
                  result: {
                    references: [],
                    chunks: [],
                    entities: [],
                    relationships: [],
                    mode: "hybrid",
                  },
                };
              }
            }
          );

          const merged = mergeBucketRetrievals(bucketResults);
          const refDate = new Map(
            merged.references.map((r) => [
              r.reference_id,
              { date: r.date, precision: r.date_precision },
            ])
          );
          const context = buildDigestContext(merged, refDate);

          const ragRetrieval: RagRetrieval = {
            query: runConfig.topic,
            mode: "digest",
            chunkMode: false,
            references: merged.references,
            chunks: merged.chunks,
            entities: [],
            relationships: [],
            appliedFilters: {
              date_from: runConfig.from,
              date_to: runConfig.to,
            },
          };
          dataStream.write({
            type: "data-retrieval",
            id: generateUUID(),
            data: ragRetrieval,
          });

          const digestResult = streamText({
            model: getLanguageModel(DEFAULT_CHAT_MODEL),
            system: buildDigestSystemPrompt(runConfig),
            messages: [
              {
                role: "user",
                content: `Write the research digest on "${runConfig.topic}" covering ${runConfig.from} to ${runConfig.to}.\n\n${context}`,
              },
            ],
            providerOptions: openaiOptions(reasoning, SYNTH_VERBOSITY),
            experimental_telemetry: {
              isEnabled: isProductionEnvironment,
              functionId: "stream-text",
            },
          });
          dataStream.merge(
            digestResult.toUIMessageStream({ sendReasoning: true })
          );

          // Stamp this run onto the chat row: advance an open-ended window's end and
          // record when/at-what-corpus-size the digest last ran (the /digest library's
          // "+N papers since last update" badge reads these). Best-effort.
          try {
            const stats = await getStats().catch(() => null);
            await updateChatDigest({
              chatId: id,
              digest: {
                ...runConfig,
                refreshedAt: new Date().toISOString(),
                ...(stats ? { papersAtRefresh: stats.papers } : {}),
              },
            });
          } catch (_) {
            /* non-fatal */
          }

          if (titlePromise) {
            try {
              const title = await titlePromise;
              dataStream.write({ type: "data-chat-title", data: title });
              updateChatTitleById({ chatId: id, title });
            } catch (_) {
              /* non-fatal */
            }
          }
          return;
        }

        // Papers the user uploaded into THIS chat — not in the database, so they can only
        // be retrieved from here (see lib/aprag/uploads.ts). Read alongside the condense
        // call so attaching a paper costs nothing in front of retrieval.
        //
        // Every kind of chat gets them, author personas included: attaching a paper and
        // asking "how does this relate to your work?" is a question that voice should be
        // able to answer, and silently dropping the attachment is worse than answering
        // from it. (Only the digest's FIRST turn skips them — that path is a dated sweep
        // of the corpus and returns before this point.)
        const uploadsPromise: Promise<UploadedPaper[]> =
          getUploadedPapersForChat({
            chatId: id,
          }).then((rows) =>
            rows.map((row) => ({
              id: row.id,
              filename: row.filename,
              title: row.title,
              intext: row.intext,
              apa: row.apa,
              pageCount: row.pageCount,
              chunks: row.chunks ?? [],
            }))
          );

        // 1. Condense into a standalone query AND run the second-pass LLM filter
        //    extraction (catches mistyped/fuzzy names the client preview misses).
        const {
          query: retrievalQuery,
          filters: inferred,
          mode: suggestedMode,
          // Produced by the same router call (+0.18s). Passing them to /retrieve
          // skips LightRAG's own keyword-extraction LLM call on the query server
          // (~1.0-1.5s per KG-mode query). Absent => unchanged behaviour.
          hlKeywords,
          llKeywords,
        } = await condenseAndExtract(toHistoryTurns(priorMessages), question);

        // Resolve "auto" to the LLM-suggested concrete mode (hybrid fallback); an explicit
        // user choice always wins.
        const retrievalMode =
          requestedMode === "auto"
            ? (suggestedMode ?? "hybrid")
            : requestedMode;

        // Which passages of the uploaded papers answer this question (whole paper when it
        // is short enough to fit — see selectUploadPassages).
        const uploadedPapers = await uploadsPromise;
        const uploadSelection =
          uploadedPapers.length > 0
            ? selectUploadPassages(uploadedPapers, retrievalQuery)
            : null;
        const hasUploads = (uploadSelection?.chunks.length ?? 0) > 0;

        // Honor the user's pre-send cancellations, then combine the client-confirmed
        // filters with the server's second-pass extraction. In a persona chat the filter
        // is FORCED to the author (their voice must only draw on their own papers) — this
        // still surfaces papers they co-authored, since the query server's author filter
        // matches any author position; the persona prompt handles the "my work" framing.
        const inferredKept = dropDismissed(inferred, dismissed ?? []);
        // A digest chat's follow-up turns stay scoped to the chat's date window by default
        // (the point of the digest) — the window rides on top of any inferred/manual filters.
        // The user can drop it for one message by removing the window chip, which sends the
        // DIGEST_WINDOW_DISMISS_KEY sentinel, letting them ask about papers outside the range.
        const windowDismissed = (dismissed ?? []).includes(
          DIGEST_WINDOW_DISMISS_KEY
        );
        const baseFilters = mergeFilters(filters ?? null, inferredKept);
        // An open-ended digest's follow-ups have no upper date bound — the chat is
        // "about" everything from `from` to the present, including papers added after
        // the last refresh.
        const effectiveFilters = persona
          ? { authors: [persona] }
          : digestConfig && !windowDismissed
            ? {
                ...baseFilters,
                date_from: digestConfig.from,
                ...(digestConfig.openEnded ? {} : { date_to: digestConfig.to }),
              }
            : baseFilters;

        // Persona chats are always answer-mode (a first-person voice, not raw chunk cards).
        const effectiveChunkMode = persona ? false : chunkMode;

        // Pinned papers: when the user pinned SEVERAL specific papers (the Papers filter),
        // retrieve each paper independently so every pinned paper is represented in the
        // context — one shared top_k would let one paper crowd out the rest, defeating
        // "compare exactly these". A single pinned paper just rides the normal filtered path.
        const pinned =
          persona || effectiveChunkMode ? [] : (effectiveFilters?.papers ?? []);
        const pinnedCompare = pinned.length >= 2 && pinned.length <= 8;

        // 2. Retrieve from the AP-RAG query server (PC, over the tunnel).
        // 3. Build the synthesis context (answer mode) — this stamps a per-passage
        //    citeIndex onto each chunk, which must be present BEFORE we serialize the
        //    chunks into the data part below. Persona chats use the authorship-tagged
        //    variant so the model knows which passages are the author's own (led) work;
        //    pinned-compare uses the paper-grouped variant.
        let retrieved: RetrieveResult;
        let context = "";
        if (pinnedCompare) {
          const perPaperK = Math.max(
            4,
            Math.min(10, Math.floor(24 / pinned.length))
          );
          const results: PinnedRetrieval[] = await mapLimit(
            pinned,
            4,
            async (p) => {
              try {
                const result = await retrieve({
                  question: retrievalQuery,
                  mode: retrievalMode,
                  filters: { ...effectiveFilters, papers: [p] },
                  chunkTopK: perPaperK,
                  hlKeywords,
                  llKeywords,
                });
                return { filename: p, result };
              } catch {
                return {
                  filename: p,
                  result: {
                    references: [],
                    chunks: [],
                    entities: [],
                    relationships: [],
                    mode: "filtered",
                  },
                };
              }
            }
          );
          const merged = mergePinnedRetrievals(results);
          context = buildPinnedContext(merged); // stamps citeIndex before serialization
          retrieved = {
            references: merged.references,
            chunks: merged.chunks,
            entities: [],
            relationships: [],
            mode: "filtered",
          };
        } else {
          retrieved = await retrieve({
            question: retrievalQuery,
            mode: retrievalMode,
            filters: effectiveFilters,
            hlKeywords,
            llKeywords,
          });
          context = effectiveChunkMode
            ? ""
            : persona
              ? buildPersonaContext(
                  retrieved.references,
                  retrieved.chunks,
                  persona
                )
              : buildContext(retrieved.references, retrieved.chunks);
        }

        // 3b. Fold in the uploaded papers. Their passages continue the SAME [n] numbering
        //     the database sources were just given, so the answer cites an uploaded paper
        //     exactly as it cites a corpus paper, and it lands in the reference list and
        //     the reader with everything else. (In chunk mode there is no synthesis, so
        //     they simply lead the chunk cards.)
        if (uploadSelection && hasUploads) {
          if (effectiveChunkMode) {
            retrieved = {
              ...retrieved,
              references: [
                ...uploadSelection.references,
                ...retrieved.references,
              ],
              chunks: [...uploadSelection.chunks, ...retrieved.chunks],
            };
          } else {
            const uploadContext = buildUploadContext(
              uploadSelection.references,
              uploadSelection.chunks,
              maxCiteIndex(retrieved.chunks)
            );
            context = context
              ? `${context}\n\n${uploadContext}`
              : uploadContext;
            retrieved = {
              ...retrieved,
              references: [
                ...retrieved.references,
                ...uploadSelection.references,
              ],
              chunks: [...retrieved.chunks, ...uploadSelection.chunks],
            };
          }
        }

        // 4. Attach the retrieval payload to the assistant message (persisted, so the
        //    UI re-renders references / inline citations / chunk cards on reload).
        const ragRetrieval: RagRetrieval = {
          query: retrievalQuery,
          mode: retrievalMode,
          chunkMode: effectiveChunkMode,
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
        if (effectiveChunkMode) {
          return;
        }

        // 4b. Answer mode: synthesize with gpt-6-luna, streamed, citing passage [n].
        // Only carry text-bearing turns into history (a prior chunk-mode turn has just a
        // data part — convertToModelMessages would otherwise produce an empty message).
        const priorForSynthesis = priorMessages.filter((m) =>
          m.parts?.some(
            (p) => p.type === "text" && (p as { text?: string }).text?.trim()
          )
        );
        const priorModelMessages =
          await convertToModelMessages(priorForSynthesis);
        // The attached papers are named right next to the question. In a conversation that
        // has been about database papers for ten turns, "how does this paper relate?" reads
        // as being about those unless something says otherwise — and the attachment, though
        // it is the newest thing in the chat, is otherwise just another block of Sources.
        const attached = hasUploads
          ? describeUploads(uploadSelection?.references ?? [])
          : "";
        const synthesisMessages: ModelMessage[] = [
          ...priorModelMessages,
          {
            role: "user",
            content: attached
              ? `${question}\n\n${attached}\n\n${context}`
              : `${question}\n\n${context}`,
          },
        ];

        const baseSystemPrompt = persona
          ? buildPersonaSystemPrompt(persona)
          : pinnedCompare
            ? buildPinnedSystemPrompt(pinned.length)
            : SYNTH_SYSTEM_PROMPT;

        const result = streamText({
          model: getLanguageModel(DEFAULT_CHAT_MODEL),
          // The uploaded papers are the user's own attachments, not corpus material — the
          // model is told which Sources they are so it never presents one as a database
          // paper (or ignores it as an outsider).
          system: hasUploads
            ? `${baseSystemPrompt}${UPLOAD_SOURCE_NOTE}`
            : baseSystemPrompt,
          messages: synthesisMessages,
          providerOptions: openaiOptions(reasoning, SYNTH_VERBOSITY),
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
              // Assistant messages have no sender.
              userId: null,
            })),
          });
        }
        // Hand the chat back: the other participants' composers re-enable and their
        // poll stops showing "asking…". Runs after the answer is persisted so nobody
        // can send into the gap between release and write.
        await releaseChatTurn({ chatId: id, userId: session.user.id });
      },
      onError: () => "Oops, an error occurred while retrieving from AP-RAG!",
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!hasRedis()) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            // Publish the id on the chat row BEFORE handing the stream to
            // resumable-stream: the other participants poll for it and attach as
            // followers, so they watch this answer arrive token by token rather than
            // waiting for the finished message. Without Redis there is no resumable
            // stream and they fall back to picking the answer up on the next poll.
            await setChatActiveStream({
              chatId: id,
              userId: session.user.id,
              streamId,
            });
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

    if (claimedTurn) {
      await releaseChatTurn(claimedTurn).catch(() => {
        /* the staleness window is the backstop */
      });
    }

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
