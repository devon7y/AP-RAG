import { auth } from "@/app/(auth)/auth";
import { fetchPdfAsset } from "@/lib/aprag/client";
import { uploadIdFromPdfName } from "@/lib/aprag/uploads";
import { getUploadedPaperById, resolveChatAccess } from "@/lib/db/queries";

// Streams one corpus PDF from the always-on PC to the in-app viewer, behind the app's
// own login (the tunnel URL and API key never reach the browser). The filename rides in
// the path rather than a query param so pdf.js, the browser cache, and "pop out" all see
// a stable, sensible URL.
//
// Range and conditional headers are forwarded and the upstream status (206/304) is
// passed through verbatim — pdf.js depends on partial responses to avoid pulling whole
// multi-megabyte files for one page.
//
// A paper the user uploaded into a chat is served here too, under the synthetic name
// "upload-<id>.pdf", from Blob storage rather than the PC. Same URL shape means the
// reader, the prefetcher and "open in a new tab" need to know nothing about it.

const PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
  "content-disposition",
];

/**
 * An uploaded paper, proxied out of Blob storage. The blob URL itself is unguessable but
 * public, so it stays server-side: readers have to come through the chat's access rules.
 */
async function serveUploadedPdf(
  request: Request,
  id: string,
  userId: string,
  download: boolean
): Promise<Response> {
  const paper = await getUploadedPaperById({ id });
  if (!paper) {
    return Response.json({ error: "pdf not found" }, { status: 404 });
  }

  // Everyone who can read the chat can read its papers. Before the chat's first message
  // there is no row to check, so only the uploader can.
  const access = await resolveChatAccess({ chatId: paper.chatId, userId });
  const allowed = access ? access.canRead : paper.userId === userId;
  if (!allowed) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const range = request.headers.get("range");
  let upstream: Response;
  try {
    upstream = await fetch(paper.blobUrl, {
      headers: range ? { Range: range } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return Response.json({ error: "file store unreachable" }, { status: 502 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return Response.json({ error: "pdf unavailable" }, { status: 502 });
  }

  const headers = new Headers();
  for (const key of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }
  headers.set("content-type", "application/pdf");
  // The paper is chat-scoped and access-checked, so it must not be cached by anything in
  // between; the browser may keep it for the session.
  headers.set("cache-control", "private, max-age=600");
  headers.set(
    "content-disposition",
    `${download ? "attachment" : "inline"}; filename="${paper.filename.replace(/"/g, "")}"`
  );
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { filename } = await params;
  const name = decodeURIComponent(filename ?? "").trim();
  if (!name.toLowerCase().endsWith(".pdf")) {
    return Response.json({ error: "not a pdf" }, { status: 400 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";

  const uploadId = uploadIdFromPdfName(name);
  if (uploadId) {
    return await serveUploadedPdf(
      request,
      uploadId,
      session.user.id as string,
      download
    );
  }

  let upstream: Response;
  try {
    upstream = await fetchPdfAsset(
      "pdf",
      { filename: name, ...(download ? { download: "true" } : {}) },
      {
        range: request.headers.get("range"),
        ifNoneMatch: request.headers.get("if-none-match"),
      }
    );
  } catch {
    return Response.json({ error: "pdf server unreachable" }, { status: 502 });
  }

  if (upstream.status === 404) {
    // Not synced to the server yet — the UI offers its Google Drive link instead.
    return Response.json({ error: "pdf not on server" }, { status: 404 });
  }
  if (upstream.status === 503) {
    return Response.json({ error: "pdf serving disabled" }, { status: 503 });
  }

  const headers = new Headers();
  for (const key of PASS_THROUGH) {
    const value = upstream.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }
  // A 304/205-class response must not carry a body.
  const body = upstream.status === 304 ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}
