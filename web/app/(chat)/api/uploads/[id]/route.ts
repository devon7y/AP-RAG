import { del } from "@vercel/blob";
import { auth } from "@/app/(auth)/auth";
import {
  deleteUploadedPaperById,
  getUploadedPaperById,
  resolveChatAccess,
} from "@/lib/db/queries";

// Remove an uploaded paper from its chat: the row goes (so no later turn retrieves from
// it) and the stored PDF goes with it.

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const paper = await getUploadedPaperById({ id });
  if (!paper) {
    return Response.json({ ok: true });
  }

  // The person who attached it, or the chat's owner. Other participants of a shared chat
  // can read an uploaded paper but not pull it out from under the conversation.
  const access = await resolveChatAccess({
    chatId: paper.chatId,
    userId: session.user.id,
  });
  const allowed = paper.userId === session.user.id || Boolean(access?.isOwner);
  if (!allowed) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  await deleteUploadedPaperById({ id });
  // Best-effort: an orphaned blob is storage, an orphaned row is a paper the chat still
  // answers from — so the row is what must go.
  await del(paper.blobUrl).catch(() => {
    /* already gone, or storage unavailable */
  });

  return Response.json({ ok: true });
}
