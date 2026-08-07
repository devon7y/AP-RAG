"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useActiveChat } from "@/hooks/use-active-chat";
import {
  type CiteRef,
  citationsInsideSentence,
  citedReferenceIds,
  disambiguationLetters,
  normalizeMath,
  rewriteIntext,
  setApaLetter,
  setIntextLetter,
  stripReferencesSection,
} from "@/lib/aprag/citations";
import type { RagChunk, RagReference, RagRetrieval } from "@/lib/aprag/types";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { CITATION_COMPONENTS, CitationContext } from "./citation-popover";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { RagChunks } from "./rag-chunks";
import { RagReferences } from "./rag-references";
import { Weather } from "./weather";

const PurePreviewMessage = ({
  addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  setMessages: _setMessages,
  regenerate: _regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onEdit,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onEdit?: (message: ChatMessage) => void;
}) => {
  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  // Group chat: label every question with the username of whoever asked it — your own
  // included, so a transcript reads consistently rather than leaving you to infer that
  // the unlabelled ones are yours. Private chats have nobody to disambiguate, so they
  // stay clean.
  const { participants, visibilityType } = useActiveChat();
  const senderId = message.metadata?.senderId;
  const senderLabel =
    isUser && senderId && visibilityType !== "private"
      ? (participants.find((p) => p.id === senderId)?.email.split("@")[0] ??
        null)
      : null;

  // AP-RAG retrieval payload attached to this assistant message (references + chunks).
  const retrievalPart = message.parts?.find(
    (part) => part.type === "data-retrieval"
  );
  const retrieval = (retrievalPart as { data?: RagRetrieval } | undefined)
    ?.data;

  // Per-passage citation maps: the answer cites passage numbers (citeIndex); each maps to
  // its source chunk and that chunk's paper (for the APA in-text label + the popover).
  const byCiteIndex = new Map<number, CiteRef>();
  const chunkByCiteIndex = new Map<number, RagChunk>();
  const refByReferenceId = new Map<string, RagReference>();
  if (retrieval) {
    for (const ref of retrieval.references) {
      refByReferenceId.set(ref.reference_id, ref);
    }
    for (const c of retrieval.chunks) {
      if (c.citeIndex == null) {
        continue;
      }
      chunkByCiteIndex.set(c.citeIndex, c);
      const ref = c.reference_id
        ? refByReferenceId.get(c.reference_id)
        : undefined;
      if (ref) {
        byCiteIndex.set(c.citeIndex, {
          referenceId: ref.reference_id,
          intext: ref.intext,
        });
      }
    }
  }

  // The answer text with any LLM-written reference list removed (the app renders the
  // real one). Used to detect which papers are actually cited in-text.
  const cleanedAnswer = isAssistant
    ? stripReferencesSection(
        message.parts
          ?.filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join("") ?? ""
      )
    : "";
  const cited =
    isAssistant && retrieval
      ? citedReferenceIds(cleanedAnswer, byCiteIndex)
      : null;
  // Only list references the answer actually cites (matches the CLI).
  const rawCitedReferences = retrieval
    ? retrieval.references.filter((r) => !cited || cited.has(r.reference_id))
    : [];

  // A paper's filename carries a year letter (Chen_Etal_2014b.pdf) so the corpus files
  // sort unambiguously; it belongs in the citation only when this answer cites two works
  // that would otherwise read identically. That is decided here, where the cited set is
  // finally known, and applied to both the reference list and the in-text cites.
  const letters = disambiguationLetters(rawCitedReferences);
  const citedReferences = rawCitedReferences.map((r) => {
    const letter = letters.get(r.reference_id) ?? "";
    return {
      ...r,
      intext: setIntextLetter(r.intext, letter),
      apa: setApaLetter(r.apa, letter),
    };
  });
  for (const [idx, ref] of byCiteIndex) {
    byCiteIndex.set(idx, {
      ...ref,
      intext: setIntextLetter(ref.intext, letters.get(ref.referenceId) ?? ""),
    });
  }
  // The chunk cards and citation popovers read the same references through context.
  for (const ref of citedReferences) {
    refByReferenceId.set(ref.reference_id, ref);
  }

  const hasText = message.parts?.some(
    (part) => part.type === "text" && part.text?.trim().length > 0
  );
  const hasAnyContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      (part.type === "reasoning" &&
        "text" in part &&
        part.text?.trim().length > 0) ||
      part.type === "data-retrieval" ||
      part.type.startsWith("tool-")
  );
  const isThinking = isAssistant && isLoading && !hasAnyContent;

  const attachments = attachmentsFromMessage.length > 0 && (
    <div
      className="flex flex-row justify-end gap-2"
      data-testid={"message-attachments"}
    >
      {attachmentsFromMessage.map((attachment) => (
        <PreviewAttachment
          attachment={{
            name: attachment.filename ?? "file",
            contentType: attachment.mediaType,
            url: attachment.url,
          }}
          key={attachment.url}
        />
      ))}
    </div>
  );

  const mergedReasoning = message.parts?.reduce(
    (acc, part) => {
      if (part.type === "reasoning" && part.text?.trim().length > 0) {
        return {
          text: acc.text ? `${acc.text}\n\n${part.text}` : part.text,
          isStreaming: "state" in part ? part.state === "streaming" : false,
          rendered: false,
        };
      }
      return acc;
    },
    { text: "", isStreaming: false, rendered: false }
  ) ?? { text: "", isStreaming: false, rendered: false };

  const parts = message.parts?.map((part, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (type === "reasoning") {
      if (!mergedReasoning.rendered && mergedReasoning.text) {
        mergedReasoning.rendered = true;
        return (
          <MessageReasoning
            isLoading={isLoading || mergedReasoning.isStreaming}
            key={key}
            reasoning={mergedReasoning.text}
          />
        );
      }
      return null;
    }

    if (type === "text") {
      // Strip any reference list the LLM wrote itself, then rewrite the answer's
      // bracketed [n] citations into clickable APA in-text cites (no-op for user
      // messages / no references). Safe on partial text while streaming — an
      // unterminated "[1" simply isn't matched yet.
      const text = isAssistant
        ? rewriteIntext(
            citationsInsideSentence(
              normalizeMath(stripReferencesSection(sanitizeText(part.text)))
            ),
            byCiteIndex
          )
        : sanitizeText(part.text);
      return (
        <MessageContent
          className={cn("text-[13px] leading-[1.65]", {
            "w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 shadow-[var(--shadow-card)]":
              message.role === "user",
          })}
          data-testid="message-content"
          key={key}
        >
          {isAssistant ? (
            <CitationContext.Provider
              value={{ chunkByCiteIndex, refByReferenceId }}
            >
              <MessageResponse components={CITATION_COMPONENTS}>
                {text}
              </MessageResponse>
            </CitationContext.Provider>
          ) : (
            <MessageResponse>{text}</MessageResponse>
          )}
        </MessageContent>
      );
    }

    if (type === "data-retrieval") {
      const data = (part as { data: RagRetrieval }).data;
      // Chunk mode renders the raw chunk cards here; answer mode renders its references
      // list after the streamed text (see ragExtras below).
      if (data.chunkMode) {
        return (
          <div key={key}>
            <RagChunks retrieval={data} />
          </div>
        );
      }
      return null;
    }

    if (type === "tool-getWeather") {
      const { toolCallId, state } = part;
      const approvalId = (part as { approval?: { id: string } }).approval?.id;
      const isDenied =
        state === "output-denied" ||
        (state === "approval-responded" &&
          (part as { approval?: { approved?: boolean } }).approval?.approved ===
            false);
      const widthClass = "w-[min(100%,450px)]";

      if (state === "output-available") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Weather weatherAtLocation={part.output} />
          </div>
        );
      }

      if (isDenied) {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state="output-denied" type="tool-getWeather" />
              <ToolContent>
                <div className="px-4 py-3 text-muted-foreground text-sm">
                  Weather lookup was denied.
                </div>
              </ToolContent>
            </Tool>
          </div>
        );
      }

      if (state === "approval-responded") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state={state} type="tool-getWeather" />
              <ToolContent>
                <ToolInput input={part.input} />
              </ToolContent>
            </Tool>
          </div>
        );
      }

      return (
        <div className={widthClass} key={toolCallId}>
          <Tool className="w-full" defaultOpen={true}>
            <ToolHeader state={state} type="tool-getWeather" />
            <ToolContent>
              {(state === "input-available" ||
                state === "approval-requested") && (
                <ToolInput input={part.input} />
              )}
              {state === "approval-requested" && approvalId && (
                <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                  <button
                    className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      addToolApprovalResponse({
                        id: approvalId,
                        approved: false,
                        reason: "User denied weather lookup",
                      });
                    }}
                    type="button"
                  >
                    Deny
                  </button>
                  <button
                    className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                    onClick={() => {
                      addToolApprovalResponse({
                        id: approvalId,
                        approved: true,
                      });
                    }}
                    type="button"
                  >
                    Allow
                  </button>
                </div>
              )}
            </ToolContent>
          </Tool>
        </div>
      );
    }

    if (type === "tool-createDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            Error creating document: {String(part.output.error)}
          </div>
        );
      }

      return (
        <DocumentPreview
          isReadonly={isReadonly}
          key={toolCallId}
          result={part.output}
        />
      );
    }

    if (type === "tool-updateDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            Error updating document: {String(part.output.error)}
          </div>
        );
      }

      return (
        <div className="relative" key={toolCallId}>
          <DocumentPreview
            args={{ ...part.output, isUpdate: true }}
            isReadonly={isReadonly}
            result={part.output}
          />
        </div>
      );
    }

    if (type === "tool-requestSuggestions") {
      const { toolCallId, state } = part;

      return (
        <Tool
          className="w-[min(100%,450px)]"
          defaultOpen={true}
          key={toolCallId}
        >
          <ToolHeader state={state} type="tool-requestSuggestions" />
          <ToolContent>
            {state === "input-available" && <ToolInput input={part.input} />}
            {state === "output-available" && (
              <ToolOutput
                errorText={undefined}
                output={
                  "error" in part.output ? (
                    <div className="rounded border p-2 text-red-500">
                      Error: {String(part.output.error)}
                    </div>
                  ) : (
                    <DocumentToolResult
                      isReadonly={isReadonly}
                      result={part.output}
                      type="request-suggestions"
                    />
                  )
                }
              />
            )}
          </ToolContent>
        </Tool>
      );
    }

    return null;
  });

  const actions = !isReadonly && (
    <MessageActions
      chatId={chatId}
      isLoading={isLoading}
      key={`action-${message.id}`}
      message={message}
      onEdit={onEdit ? () => onEdit(message) : undefined}
      vote={vote}
    />
  );

  // Answer-mode extras: a "synthesizing" indicator between retrieval and the first
  // token, then (only once streaming has finished) the list of cited references.
  const ragExtras = isAssistant && retrieval && !retrieval.chunkMode && (
    <>
      {!hasText && isLoading && (
        <div className="flex h-[calc(13px*1.65)] items-center text-[13px] leading-[1.65]">
          <Shimmer className="font-medium" duration={1}>
            Synthesizing answer…
          </Shimmer>
        </div>
      )}
      {!isLoading && <RagReferences references={citedReferences} />}
    </>
  );

  const content = isThinking ? (
    <div className="flex h-[calc(13px*1.65)] items-center text-[13px] leading-[1.65]">
      <Shimmer className="font-medium" duration={1}>
        Searching the corpus…
      </Shimmer>
    </div>
  ) : (
    <>
      {attachments}
      {parts}
      {ragExtras}
      {actions}
    </>
  );

  // A finished assistant turn with nothing to show is a stream artifact, not a message:
  // the retrieval payload can land in its own message, and once the answer cites nothing
  // from it there is no text, no references and no chunks to render — leaving an empty
  // bubble that still carried an avatar and a copy button. Drop it entirely.
  // (Only when loading has finished; mid-stream a message is legitimately empty.)
  const hasReasoning = message.parts?.some(
    (part) =>
      part.type === "reasoning" &&
      "text" in part &&
      part.text?.trim().length > 0
  );
  const hasToolPart = message.parts?.some((part) =>
    part.type.startsWith("tool-")
  );
  const showsRetrieval = Boolean(
    retrieval &&
      (retrieval.chunkMode
        ? retrieval.chunks.length > 0
        : citedReferences.length > 0)
  );
  if (
    isAssistant &&
    !isLoading &&
    !(hasText || hasReasoning || hasToolPart || showsRetrieval)
  ) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]"
      )}
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          isUser ? "flex flex-col items-end gap-2" : "flex items-start gap-3"
        )}
      >
        {isAssistant && (
          <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
            <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
              <SparklesIcon size={13} />
            </div>
          </div>
        )}
        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{content}</div>
        ) : (
          <>
            {/* In a shared chat, every question is signed with its asker's username. */}
            {senderLabel && (
              <span className="-mb-1 px-1 text-[11px] text-muted-foreground">
                {senderLabel}
              </span>
            )}
            {content}
          </>
        )}
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

// Somebody else in a shared chat has started writing. Sits where their message will
// land (user messages are right-aligned) so the thread visibly makes room for it.
export const TypingMessage = ({ name }: { name: string }) => {
  return (
    <div className="group/message w-full" data-role="user-typing">
      <div className="flex flex-col items-end gap-2">
        <div className="flex h-[calc(13px*1.65)] items-center pr-1 text-[11px] text-muted-foreground leading-[1.65]">
          <Shimmer duration={1}>{`${name} is typing…`}</Shimmer>
        </div>
      </div>
    </div>
  );
};

export const ThinkingMessage = () => {
  return (
    <div
      className="group/message w-full"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
          <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
            <SparklesIcon size={13} />
          </div>
        </div>

        <div className="flex h-[calc(13px*1.65)] items-center text-[13px] leading-[1.65]">
          <Shimmer className="font-medium" duration={1}>
            Checking the database…
          </Shimmer>
        </div>
      </div>
    </div>
  );
};
