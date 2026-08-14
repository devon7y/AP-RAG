import { del, head } from "@vercel/blob";
import { auth } from "@/app/(auth)/auth";
import type { UploadedPaperSummary } from "@/lib/aprag/types";
import {
  extractPdfPages,
  identifyPaper,
  looksLikePdf,
  PdfReadError,
} from "@/lib/aprag/upload-pdf";
import {
  chunkPages,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_CHAT,
} from "@/lib/aprag/uploads";
import {
  countUploadedPapers,
  listUploadedPapers,
  resolveChatAccess,
  saveUploadedPaper,
  type UploadedPaperMeta,
} from "@/lib/db/queries";

// Papers a user attaches to a chat that are NOT in the AP-RAG database — uploaded so the
// conversation can discuss them alongside the corpus.
//
// The PDF does NOT arrive here. A serverless function rejects any request body over 4.5MB
// with a plain-text 413 before the handler runs, and academic papers are routinely larger
// than that, so the browser uploads straight to the blob store (./blob issues the token)
// and this route is handed the resulting URL. Reading the blob back server-side has no
// such limit.
//
// From there it is one request: read the stored PDF, extract its text page by page, chunk
// it, and read its front matter for a citation. When this returns, the paper is
// answerable — which is why the composer shows it as "Reading…" until it does. Anything
// that goes wrong takes the stored file with it, rather than leaving an orphan behind.
//
// PDFs only. Not a policy about file types so much as about what the rest of the pipeline
// can do: the chunker, the citation plumbing and the reader are all built around a paper
// with pages.

// Reading and identifying the paper both happen in this one request.
export const maxDuration = 120;

/** Extraction below this is a scan or an image-only PDF — there is nothing to retrieve. */
const MIN_EXTRACTED_CHARS = 400;
/** How much of the front matter the identification step reads. */
const FRONT_MATTER_PAGES = 3;

function summarize(
  row: UploadedPaperMeta,
  viewerId: string
): UploadedPaperSummary {
  return {
    id: row.id,
    filename: row.filename,
    title: row.title,
    intext: row.intext,
    apa: row.apa,
    year: row.year,
    pageCount: row.pageCount,
    chunkCount: Number(row.chunkCount ?? 0),
    createdAt: row.createdAt.toISOString(),
    uploadedBy: row.uploaderEmail ? row.uploaderEmail.split("@")[0] : null,
    isOwn: row.userId === viewerId,
  };
}

/**
 * Who may attach papers to (and see the attachments of) a chat. A chat with no row yet is
 * one whose first message hasn't been sent — its id was minted by this client, so the
 * uploader is its owner-to-be.
 */
async function checkAccess(
  chatId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const access = await resolveChatAccess({ chatId, userId });
  if (!access) {
    return { ok: true };
  }
  if (!access.canWrite) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true };
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const chatId = new URL(request.url).searchParams.get("chatId")?.trim();
  if (!chatId) {
    return Response.json({ error: "chatId required" }, { status: 400 });
  }

  const access = await resolveChatAccess({ chatId, userId: session.user.id });
  if (access && !access.canRead) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await listUploadedPapers({ chatId });
  return Response.json({
    papers: rows.map((row) => summarize(row, session.user.id as string)),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // The browser has already put the PDF in the blob store (see ./blob) — this request is
  // only the small JSON that says which one to read.
  let body: { chatId?: string; url?: string; filename?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }

  const chatId = String(body.chatId ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
    return Response.json({ error: "chatId required" }, { status: 400 });
  }

  const access = await checkAccess(chatId, userId);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }

  const filename = (body.filename || "paper.pdf").slice(0, 200);
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return Response.json(
      { error: `${filename} isn't a PDF. Only PDFs can be uploaded.` },
      { status: 400 }
    );
  }

  const existing = await countUploadedPapers({ chatId });
  if (existing >= MAX_UPLOADS_PER_CHAT) {
    return Response.json(
      {
        error: `This chat already has ${MAX_UPLOADS_PER_CHAT} uploaded papers. Remove one first.`,
      },
      { status: 400 }
    );
  }

  // The client names the blob to read, so the claim is checked rather than trusted: `head`
  // speaks for our own store only, which both proves the blob is ours and gives us its
  // real size and path. A URL pointing anywhere else simply isn't found.
  const blobUrl = String(body.url ?? "");
  let stored: Awaited<ReturnType<typeof head>>;
  try {
    stored = await head(blobUrl);
  } catch {
    return Response.json({ error: "Unknown upload." }, { status: 400 });
  }
  if (!stored.pathname.startsWith(`chat-uploads/${chatId}/`)) {
    return Response.json({ error: "Unknown upload." }, { status: 400 });
  }

  /** Nothing usable came of the file — don't leave it sitting in the store. */
  const discard = async () => {
    await del(blobUrl).catch(() => {
      /* best-effort */
    });
  };

  if (stored.size > MAX_UPLOAD_BYTES) {
    await discard();
    return Response.json(
      {
        error: `${filename} is ${(stored.size / 1024 / 1024).toFixed(1)} MB — the limit is ${
          MAX_UPLOAD_BYTES / 1024 / 1024
        } MB.`,
      },
      { status: 400 }
    );
  }

  let bytes: Uint8Array;
  try {
    const response = await fetch(blobUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    await discard();
    return Response.json(
      { error: "The uploaded file couldn't be read back. Please try again." },
      { status: 502 }
    );
  }

  // The declared type is whatever the browser guessed from the extension; the bytes are
  // the actual claim to being a PDF.
  if (!looksLikePdf(bytes)) {
    await discard();
    return Response.json(
      { error: `${filename} isn't a valid PDF file.` },
      { status: 400 }
    );
  }

  let extracted: Awaited<ReturnType<typeof extractPdfPages>>;
  try {
    extracted = await extractPdfPages(bytes);
  } catch (error) {
    if (error instanceof PdfReadError) {
      // A reader that won't start is our fault, not a bad request — and worth a 5xx so it
      // shows up as a server error rather than as user error. The file stays: it is fine,
      // and a retry once the server is fixed should not need re-uploading.
      if (error.reason === "unavailable") {
        return Response.json({ error: error.message }, { status: 503 });
      }
      await discard();
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to read uploaded PDF:", error);
    await discard();
    return Response.json(
      {
        error:
          `Couldn't read ${filename}: ${(error as Error).message ?? ""}`.trim(),
      },
      { status: 400 }
    );
  }

  if (extracted.chars < MIN_EXTRACTED_CHARS) {
    await discard();
    return Response.json(
      {
        error: `${filename} has no text layer — it looks like a scan. Run OCR on it and upload it again.`,
      },
      { status: 400 }
    );
  }

  const chunks = chunkPages(extracted.pages);
  if (chunks.length === 0) {
    await discard();
    return Response.json(
      { error: `No readable text could be extracted from ${filename}.` },
      { status: 400 }
    );
  }

  const frontMatter = extracted.pages
    .slice(0, FRONT_MATTER_PAGES)
    .map((p) => p.text)
    .join("\n");

  // The identification is a nicety (it decides how the paper is cited); the upload is not
  // worth failing over it, and identifyPaper already falls back to the file name.
  const identity = await identifyPaper(frontMatter, filename);

  const row = await saveUploadedPaper({
    chatId,
    userId,
    filename,
    blobUrl: stored.url,
    blobPathname: stored.pathname,
    byteSize: stored.size,
    pageCount: extracted.pageCount,
    title: identity.title,
    apa: identity.apa,
    intext: identity.intext,
    year: identity.year,
    chunks,
  });

  return Response.json({
    paper: summarize(
      {
        ...row,
        chunkCount: chunks.length,
        uploaderEmail: session.user.email ?? null,
      },
      userId
    ),
  });
}
