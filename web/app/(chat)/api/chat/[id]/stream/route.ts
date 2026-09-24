import { auth } from "@/app/(auth)/auth";
import { getChatActivity, resolveChatAccess } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { getStreamContext } from "../../route";

// Attach to the answer currently being written in this chat.
//
// Two callers, one mechanism. The AI SDK's own `resumeStream()` hits this after a
// reload/reconnect so the SENDER picks their half-finished answer back up; the group-chat
// poll hits it when it sees another participant holding the turn, so FOLLOWERS watch that
// answer stream in token by token. Both resume the same resumable-stream id (published on
// the chat row by the POST handler) from character 0 — a follower who joins late gets the
// text so far and then the live deltas.
//
// 204 means "nothing is streaming": no active turn, no Redis (resumable streams are
// optional), or the stream already finished — in which case the answer is in the database
// and the poll picks it up as a normal message.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const access = await resolveChatAccess({
    chatId: id,
    userId: session.user.id,
  });
  if (!access) {
    return new ChatbotError("not_found:chat").toResponse();
  }
  if (!access.canRead) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const activity = await getChatActivity({ chatId: id });
  const streamId = activity?.activeStreamId;
  if (!streamId) {
    return new Response(null, { status: 204 });
  }

  const streamContext = await getStreamContext();
  if (!streamContext) {
    return new Response(null, { status: 204 });
  }

  let resumed: ReadableStream<string> | null | undefined;
  try {
    resumed = await streamContext.resumeExistingStream(streamId);
  } catch (_) {
    return new Response(null, { status: 204 });
  }

  if (!resumed) {
    return new Response(null, { status: 204 });
  }

  return new Response(resumed, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Marks the body as the AI SDK's UI message stream protocol, matching what
      // createUIMessageStreamResponse sets on the original response.
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
