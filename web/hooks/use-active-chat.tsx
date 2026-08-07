"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePathname } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { useDataStream } from "@/components/chat/data-stream-provider";
import { getChatHistoryPaginationKey } from "@/components/chat/sidebar-history";
import { toast } from "@/components/chat/toast";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { useAutoResume } from "@/hooks/use-auto-resume";
import { type Participant, username } from "@/hooks/use-chat-participants";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_RETRIEVAL_MODE,
  type ReasoningEffort,
  type RetrievalMode,
} from "@/lib/ai/models";
import type { RagFilters, RagRetrieval } from "@/lib/aprag/types";
import type { Vote } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { prefetchReferences } from "@/lib/pdf/loader";
import type { ChatMessage } from "@/lib/types";
import { fetcher, fetchWithErrorHandlers, generateUUID } from "@/lib/utils";

type ActiveChatContextValue = {
  chatId: string;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  visibilityType: VisibilityType;
  isReadonly: boolean;
  isLoading: boolean;
  votes: Vote[] | undefined;
  currentModelId: string;
  setCurrentModelId: (id: string) => void;
  showCreditCardAlert: boolean;
  setShowCreditCardAlert: Dispatch<SetStateAction<boolean>>;
  // AP-RAG controls (mirror the CLI flags).
  reasoning: ReasoningEffort;
  setReasoning: Dispatch<SetStateAction<ReasoningEffort>>;
  retrievalMode: RetrievalMode;
  setRetrievalMode: Dispatch<SetStateAction<RetrievalMode>>;
  chunkMode: boolean;
  setChunkMode: Dispatch<SetStateAction<boolean>>;
  filters: RagFilters | null;
  setFilters: Dispatch<SetStateAction<RagFilters | null>>;
  // "Talk to Author": the author this chat is scoped to (null for a normal chat).
  personaAuthor: string | null;
  // "Research Digest": the topic + date window this chat summarizes (null for a normal chat).
  digest: DigestChatConfig | null;
  // Group chat. `participants` is everyone with access (owner first) and drives the
  // per-message bylines; `busyByOther` is true while ANOTHER participant holds the turn,
  // which disables this composer — a chat answers one question at a time.
  participants: Participant[];
  viewerId: string | null;
  busyByOther: boolean;
  activeParticipantName: string | null;
  // Other people with text in their composer right now (usernames), and the heartbeat
  // this client posts while ITS composer has text.
  typingNames: string[];
  sendTyping: (typing: boolean) => void;
};

// The digest config carried in the URL / persisted on the chat row (bucket is derived
// server-side). `openEnded` marks a "to present" digest — its window's end tracks "now"
// and the digest can be refreshed as papers are added (refreshedAt / papersAtRefresh are
// stamped server-side on each run, for the /digest library's "+N papers" badge).
export type DigestChatConfig = {
  topic: string;
  from: string;
  to: string;
  bucket?: "month" | "year";
  openEnded?: boolean;
  refreshedAt?: string;
  papersAtRefresh?: number;
};

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
}

export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setDataStream } = useDataStream();
  const { mutate } = useSWRConfig();

  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;

  const [currentModelId, setCurrentModelId] = useState(DEFAULT_CHAT_MODEL);
  const currentModelIdRef = useRef(currentModelId);
  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  const [input, setInput] = useState("");
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);

  // AP-RAG controls. Kept in refs too so prepareSendMessagesRequest (created once) reads
  // the latest value without re-instantiating the transport.
  const [reasoning, setReasoning] = useState<ReasoningEffort>(
    DEFAULT_REASONING_EFFORT
  );
  const reasoningRef = useRef(reasoning);
  useEffect(() => {
    reasoningRef.current = reasoning;
  }, [reasoning]);

  const [retrievalMode, setRetrievalMode] = useState<RetrievalMode>(
    DEFAULT_RETRIEVAL_MODE
  );
  const retrievalModeRef = useRef(retrievalMode);
  useEffect(() => {
    retrievalModeRef.current = retrievalMode;
  }, [retrievalMode]);

  const [chunkMode, setChunkMode] = useState(false);
  const chunkModeRef = useRef(chunkMode);
  useEffect(() => {
    chunkModeRef.current = chunkMode;
  }, [chunkMode]);

  const [filters, setFilters] = useState<RagFilters | null>(null);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  // "Talk to Author": the author a chat is pinned to. Sourced from the `?author=` param on
  // a fresh author chat, or from /api/messages on reload; remembered per chat id so it
  // survives the URL-param strip and chat switches. Sent on the first message so the route
  // can persist it onto the new Chat row (thereafter the row is authoritative).
  const [digest, setDigest] = useState<DigestChatConfig | null>(null);
  const digestRef = useRef(digest);
  useEffect(() => {
    digestRef.current = digest;
  }, [digest]);
  const digestByChat = useRef(new Map<string, DigestChatConfig>());

  // useChat's onFinish is created before the transcript SWR below exists, so it reaches
  // the refresher through a ref rather than closing over it.
  const refreshChatDataRef = useRef<(() => void) | null>(null);

  const [personaAuthor, setPersonaAuthor] = useState<string | null>(null);
  const personaAuthorRef = useRef(personaAuthor);
  useEffect(() => {
    personaAuthorRef.current = personaAuthor;
  }, [personaAuthor]);
  const personaByChat = useRef(new Map<string, string>());

  const {
    data: chatData,
    isLoading,
    mutate: refreshChatData,
  } = useSWR(
    isNewChat
      ? null
      : `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const initialMessages: ChatMessage[] = isNewChat
    ? []
    : (chatData?.messages ?? []);
  const visibility: VisibilityType = isNewChat
    ? "private"
    : (chatData?.visibility ?? "private");

  // GROUP CHAT HEARTBEAT.
  //
  // A shared chat has other people in it who can post at any moment, so this client can't
  // just load the transcript once. It polls a deliberately tiny endpoint — last message
  // id, message count, and who (if anyone) is mid-answer — and reacts:
  //
  //   * somebody posted, or an answer landed  -> refetch the transcript
  //   * somebody is answering RIGHT NOW       -> attach to their stream and watch the
  //                                              tokens arrive, same as if we'd asked
  //   * somebody is TYPING right now          -> say so, and block this composer
  //
  // Private chats never poll (nobody else can write to them), and SWR pauses polling
  // while the tab is hidden, so an idle background tab costs nothing.
  const isShared = !isNewChat && visibility !== "private";
  const { data: chatState } = useSWR<{
    exists: boolean;
    activeStreamId: string | null;
    activeUserId: string | null;
    activeUserEmail: string | null;
    lastMessageId: string | null;
    messageCount: number;
    participants: Participant[];
    busyByOther: boolean;
    typing: { id: string; email: string }[];
  }>(
    isShared
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat/${chatId}/state`
      : null,
    fetcher,
    // 2s: this poll now carries presence ("…is typing"), which reads as broken if it
    // lags far behind the keystrokes it is reporting.
    { refreshInterval: 2000, revalidateOnFocus: true, dedupingInterval: 1000 }
  );

  const participants: Participant[] =
    chatState?.participants ?? chatData?.participants ?? [];
  const viewerId: string | null = chatData?.viewerId ?? null;
  const busyByOther = Boolean(chatState?.busyByOther);
  // Resolved from the email the state endpoint returns rather than by looking the id up
  // in `participants`: in a PUBLIC chat the asker needn't be a listed participant.
  const activeParticipantName = busyByOther
    ? chatState?.activeUserEmail
      ? username({ email: chatState.activeUserEmail })
      : "Someone"
    : null;

  const typingNames = useMemo(
    () => (chatState?.typing ?? []).map((t) => username(t)),
    [chatState?.typing]
  );

  // Announce that this client's composer has (or no longer has) text in it. Fire and
  // forget — presence is decoration, and a dropped beat ages out on its own.
  const sendTyping = useCallback(
    (typing: boolean) => {
      if (!isShared) {
        return;
      }
      fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat/${chatId}/typing`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ typing }),
          // Lets the "I stopped typing" beat survive the page being closed.
          keepalive: true,
        }
      ).catch(() => {
        /* best-effort */
      });
    },
    [chatId, isShared]
  );

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    id: chatId,
    messages: initialMessages,
    generateId: generateUUID,
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
    transport: new DefaultChatTransport({
      api: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat`,
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);
        const isToolApprovalContinuation =
          lastMessage?.role !== "user" ||
          request.messages.some((msg) =>
            msg.parts?.some((part) => {
              const state = (part as { state?: string }).state;
              return (
                state === "approval-responded" || state === "output-denied"
              );
            })
          );

        return {
          body: {
            id: request.id,
            ...(isToolApprovalContinuation
              ? { messages: request.messages }
              : { message: lastMessage }),
            selectedChatModel: currentModelIdRef.current,
            selectedVisibilityType: visibility,
            reasoning: reasoningRef.current,
            mode: retrievalModeRef.current,
            chunkMode: chunkModeRef.current,
            ...(filtersRef.current ? { filters: filtersRef.current } : {}),
            ...(personaAuthorRef.current
              ? { personaAuthor: personaAuthorRef.current }
              : {}),
            ...(digestRef.current
              ? {
                  digest: {
                    topic: digestRef.current.topic,
                    from: digestRef.current.from,
                    to: digestRef.current.to,
                    ...(digestRef.current.openEnded ? { openEnded: true } : {}),
                  },
                }
              : {}),
            ...request.body,
          },
        };
      },
    }),
    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
      // The retrieval payload lands BEFORE the answer finishes streaming, so this is the
      // earliest possible moment to start warming the PDFs the reader is most likely to
      // open — by the time they hover a citation, the bytes are already there. References
      // arrive frequency-ranked, so plain order is the importance signal.
      if (dataPart.type === "data-retrieval") {
        const refs =
          (dataPart.data as RagRetrieval | undefined)?.references ?? [];
        prefetchReferences(
          refs.map((r) => ({ filename: r.filename, page: r.pages?.[0] ?? 1 }))
        );
      }
      // Note: we deliberately do NOT sync the composer's active-filter chips to the
      // server's appliedFilters here — filters are one-shot per message (cleared on send),
      // so re-populating them would make them "stick" onto the next message.
    },
    onFinish: () => {
      mutate(unstable_serialize(getChatHistoryPaginationKey));
      // Re-read the transcript now that the turn is persisted: it comes back with sender
      // attribution stamped on, and it re-aligns this client with the poll's stamp so the
      // next tick doesn't look like a change.
      refreshChatDataRef.current?.();
    },
    onError: (error) => {
      if (error.message?.includes("AI Gateway requires a valid credit card")) {
        setShowCreditCardAlert(true);
      } else if (error instanceof ChatbotError) {
        toast({ type: "error", description: error.message });
      } else {
        toast({
          type: "error",
          description: error.message || "Oops, an error occurred!",
        });
      }
    },
  });

  refreshChatDataRef.current = refreshChatData;

  // Read inside effects without making them re-run on every streamed token.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // True while a turn is in flight in THIS client — either one we sent, or one we're
  // following. Both cases must be left alone by the transcript sync below.
  const isBusyLocally = status === "streaming" || status === "submitted";

  // Apply the server's transcript. This is the initial load AND, in a shared chat, how
  // another participant's messages arrive. It only ever adds: if the fetched transcript
  // holds nothing we don't already have, it's left alone — otherwise a stale response
  // landing just after our own turn would roll the answer back off the screen.
  useEffect(() => {
    if (isNewChat) {
      return;
    }
    const incoming = chatData?.messages as ChatMessage[] | undefined;
    if (!incoming?.length) {
      return;
    }
    if (isBusyLocally) {
      return;
    }
    const known = new Set(messagesRef.current.map((m) => m.id));
    const hasNew = incoming.some((m) => !known.has(m.id));
    if (!(hasNew || messagesRef.current.length === 0)) {
      return;
    }
    setMessages(incoming);
    // Keyed on the fetched transcript alone: switching chats changes the SWR key, so
    // `chatData` is undefined until the new chat's messages land and this bails above.
  }, [chatData?.messages, isBusyLocally, isNewChat, setMessages]);

  // The poll saw the transcript move (someone posted, or an answer finished) — fetch it.
  // The effect above merges it in as soon as this client is idle.
  const lastSeenStampRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatState?.exists) {
      return;
    }
    const stamp = `${chatState.lastMessageId ?? ""}:${chatState.messageCount}`;
    if (lastSeenStampRef.current === stamp) {
      return;
    }
    lastSeenStampRef.current = stamp;
    refreshChatData();
  }, [
    chatState?.exists,
    chatState?.lastMessageId,
    chatState?.messageCount,
    refreshChatData,
  ]);

  // Someone else is answering right now: attach to their stream so the answer types out
  // here too, instead of appearing all at once when they're done. `resumeStream` is the
  // AI SDK's own reconnect path — the follower and the original sender resume the same
  // resumable-stream id. The transcript is pulled FIRST so their question is on screen
  // before its answer starts arriving under it.
  const followingStreamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatState?.busyByOther) {
      followingStreamRef.current = null;
      return;
    }
    const streamId = chatState.activeStreamId;
    if (!streamId || followingStreamRef.current === streamId) {
      return;
    }
    // Our own turn wins; we'd only be here on a stale tick.
    if (isBusyLocally) {
      return;
    }
    followingStreamRef.current = streamId;
    refreshChatData().finally(() => {
      resumeStream();
    });
  }, [
    chatState?.busyByOther,
    chatState?.activeStreamId,
    isBusyLocally,
    refreshChatData,
    resumeStream,
  ]);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      // Switching chats (new or existing): start fresh — clear the composer text and any
      // active metadata filters so they don't leak across conversations. Restore this
      // chat's remembered author (if any); the ?author= / chatData effects fill it in for
      // a chat we haven't seen yet.
      setInput("");
      setFilters(null);
      setPersonaAuthor(personaByChat.current.get(chatId) ?? null);
      setDigest(digestByChat.current.get(chatId) ?? null);
      // The live-sync bookkeeping is per chat; carrying it across would make the new
      // chat's first poll look like "nothing changed".
      lastSeenStampRef.current = null;
      followingStreamRef.current = null;
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setMessages]);

  // Restore an existing author chat's persona from the messages payload (reload / deep
  // link). The row is authoritative once it exists.
  useEffect(() => {
    const author = (chatData as { personaAuthor?: string | null } | undefined)
      ?.personaAuthor;
    if (author) {
      personaByChat.current.set(chatId, author);
      setPersonaAuthor(author);
    }
  }, [chatId, chatData]);

  // Restore an existing digest chat's config from the messages payload (reload / deep link).
  useEffect(() => {
    const d = (chatData as { digest?: DigestChatConfig | null } | undefined)
      ?.digest;
    if (d) {
      digestByChat.current.set(chatId, d);
      setDigest(d);
    }
  }, [chatId, chatData]);

  // Capture the author of a freshly-opened Talk-to-Author chat from `?author=`, remember
  // it for this chat id, then strip the param (keeping any other params, e.g. ?query=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const author = params.get("author")?.trim();
    if (!author) {
      return;
    }
    personaByChat.current.set(chatId, author);
    setPersonaAuthor(author);
    personaAuthorRef.current = author;
    params.delete("author");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}${qs ? `?${qs}` : ""}`
    );
  }, [chatId]);

  // Capture a freshly-opened Research Digest chat's config from `?digest=` (URL-encoded
  // JSON), remember it for this chat id, strip the param, and AUTO-SEND the user's prompt as
  // the first message — so the chat opens straight into the live digest (no empty greeting/
  // suggestions step). digestRef is set before sendMessage so the config rides that message.
  const sentDigestChatIds = useRef(new Set<string>());
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("digest");
    if (!raw) {
      return;
    }
    let parsed: DigestChatConfig | null = null;
    try {
      const o = JSON.parse(raw) as Partial<DigestChatConfig>;
      if (o && typeof o.topic === "string" && o.from && o.to) {
        parsed = {
          topic: o.topic,
          from: o.from,
          to: o.to,
          ...(o.openEnded ? { openEnded: true } : {}),
        };
      }
    } catch {
      /* malformed param — ignore */
    }
    if (!parsed) {
      return;
    }
    digestByChat.current.set(chatId, parsed);
    setDigest(parsed);
    digestRef.current = parsed;
    params.delete("digest");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}${qs ? `?${qs}` : ""}`
    );
    if (!sentDigestChatIds.current.has(chatId)) {
      sentDigestChatIds.current.add(chatId);
      sendMessage({
        role: "user" as const,
        parts: [{ type: "text", text: parsed.topic }],
      });
    }
  }, [chatId, sendMessage]);

  // Pin papers on a freshly-opened chat from `?papers=` (comma-separated filenames —
  // "Ask about this paper" and related-papers links use this). The ref is set
  // synchronously so a same-mount `?query=` auto-send already carries the filter.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("papers");
    if (!raw) {
      return;
    }
    const files = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (files.length > 0) {
      const next: RagFilters = { ...(filtersRef.current ?? {}), papers: files };
      filtersRef.current = next;
      setFilters(next);
    }
    params.delete("papers");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}${qs ? `?${qs}` : ""}`
    );
  }, [chatId]);

  useEffect(() => {
    if (chatData && !isNewChat) {
      const cookieModel = document.cookie
        .split("; ")
        .find((row) => row.startsWith("chat-model="))
        ?.split("=")[1];
      if (cookieModel) {
        setCurrentModelId(decodeURIComponent(cookieModel));
      }
    }
  }, [chatData, isNewChat]);

  const hasAppendedQueryRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");
    if (query && !hasAppendedQueryRef.current) {
      hasAppendedQueryRef.current = true;
      window.history.replaceState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      sendMessage({
        role: "user" as const,
        parts: [{ type: "text", text: query }],
      });
    }
  }, [sendMessage, chatId]);

  // "Update" from the /digest library: `?digestRefresh=1` on an EXISTING digest chat
  // re-runs the digest over its window extended to now. Waits until the chat's digest
  // config (and message history) have loaded, then auto-sends the refresh once.
  const sentRefreshChatIds = useRef(new Set<string>());
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("digestRefresh") !== "1") {
      return;
    }
    if (!(chatData && digest)) {
      return; // effect re-runs once the chat + digest config arrive
    }
    params.delete("digestRefresh");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}${qs ? `?${qs}` : ""}`
    );
    if (!sentRefreshChatIds.current.has(chatId)) {
      sentRefreshChatIds.current.add(chatId);
      sendMessage(
        {
          role: "user" as const,
          parts: [
            {
              type: "text",
              text: "Update this digest with the papers added since the last refresh.",
            },
          ],
        },
        { body: { digestRefresh: true } }
      );
    }
  }, [chatId, chatData, digest, sendMessage]);

  useAutoResume({
    autoResume: !isNewChat && !!chatData,
    initialMessages,
    resumeStream,
    setMessages,
  });

  const isReadonly = isNewChat ? false : (chatData?.isReadonly ?? false);

  const { data: votes } = useSWR<Vote[]>(
    !isReadonly && messages.length >= 2
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/vote?chatId=${chatId}`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const value = useMemo<ActiveChatContextValue>(
    () => ({
      chatId,
      messages,
      setMessages,
      sendMessage,
      status,
      stop,
      regenerate,
      addToolApprovalResponse,
      input,
      setInput,
      visibilityType: visibility,
      isReadonly,
      isLoading: !isNewChat && isLoading,
      votes,
      currentModelId,
      setCurrentModelId,
      showCreditCardAlert,
      setShowCreditCardAlert,
      reasoning,
      setReasoning,
      retrievalMode,
      setRetrievalMode,
      chunkMode,
      setChunkMode,
      filters,
      setFilters,
      personaAuthor,
      digest,
      participants,
      viewerId,
      busyByOther,
      activeParticipantName,
      typingNames,
      sendTyping,
    }),
    [
      chatId,
      messages,
      setMessages,
      sendMessage,
      status,
      stop,
      regenerate,
      addToolApprovalResponse,
      input,
      visibility,
      isReadonly,
      isNewChat,
      isLoading,
      votes,
      currentModelId,
      showCreditCardAlert,
      reasoning,
      retrievalMode,
      chunkMode,
      filters,
      personaAuthor,
      digest,
      participants,
      viewerId,
      busyByOther,
      activeParticipantName,
      typingNames,
      sendTyping,
    ]
  );

  return (
    <ActiveChatContext.Provider value={value}>
      {children}
    </ActiveChatContext.Provider>
  );
}

export function useActiveChat() {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error("useActiveChat must be used within ActiveChatProvider");
  }
  return context;
}
