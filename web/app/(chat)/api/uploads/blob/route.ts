import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { auth } from "@/app/(auth)/auth";
import { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_CHAT } from "@/lib/aprag/uploads";
import { countUploadedPapers, resolveChatAccess } from "@/lib/db/queries";

// Authorizes a browser to write ONE paper straight into Blob storage.
//
// The PDF cannot travel through a serverless function: Vercel rejects any request body
// over 4.5MB with a plain-text 413 before the handler runs, and academic papers are
// routinely larger than that. So the browser uploads directly to the blob store and this
// route only issues the one-shot token for it — the file never passes through here, which
// is also why the size limit below is enforced by the store rather than by us.
//
// Everything that decides whether the upload is allowed at all happens here, before the
// token exists: who is asking, whether they can write to this chat, and whether the chat
// has room. `/api/uploads` then reads the stored blob and turns it into a paper.

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const session = await auth();
        if (!session?.user?.id) {
          throw new Error("unauthorized");
        }

        let chatId = "";
        try {
          chatId = String(
            (JSON.parse(clientPayload ?? "{}") as { chatId?: string }).chatId ??
              ""
          );
        } catch {
          throw new Error("bad request");
        }
        if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
          throw new Error("bad request");
        }
        // A chat with no row yet is one whose first message hasn't been sent; its id was
        // minted by this client, so the uploader is its owner-to-be.
        const access = await resolveChatAccess({
          chatId,
          userId: session.user.id,
        });
        if (access && !access.canWrite) {
          throw new Error("forbidden");
        }
        if ((await countUploadedPapers({ chatId })) >= MAX_UPLOADS_PER_CHAT) {
          throw new Error(
            `This chat already has ${MAX_UPLOADS_PER_CHAT} uploaded papers.`
          );
        }
        // The token is scoped to this one path prefix, one content type and one size, so
        // it cannot be replayed to write anything else into the store.
        if (!pathname.startsWith(`chat-uploads/${chatId}/`)) {
          throw new Error("bad request");
        }

        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
        };
      },
      // Vercel calls this from its own servers when the upload lands. Nothing to do: the
      // browser tells /api/uploads to read the blob, and that request is the one that
      // has to succeed for the paper to exist at all.
      onUploadCompleted: async () => {
        /* no-op */
      },
    });
    return Response.json(result);
  } catch (error) {
    const message = (error as Error).message || "upload not allowed";
    const status =
      message === "unauthorized" ? 401 : message === "forbidden" ? 403 : 400;
    return Response.json({ error: message }, { status });
  }
}
