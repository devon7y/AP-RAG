import { auth } from "@/app/(auth)/auth";
import { fetchPdfAsset } from "@/lib/aprag/client";
import { isUploadPdfName } from "@/lib/aprag/uploads";

// One page of a corpus PDF as a WebP image (~285KB at the default width), rendered and
// disk-cached on the PC. The viewer paints this immediately while pdf.js is still
// fetching/parsing the real document, and a pinned citation popover uses it as a preview
// — both cases where waiting on a multi-megabyte PDF would feel slow.

const PASS_THROUGH = [
  "content-type",
  "content-length",
  "etag",
  "cache-control",
  "x-page-count",
  "x-page-rendered",
];

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;
  const filename = sp.get("filename")?.trim();
  if (!filename?.toLowerCase().endsWith(".pdf")) {
    return Response.json({ error: "filename required" }, { status: 400 });
  }
  // A paper uploaded into a chat lives in Blob storage, not on the PC, so there is no
  // pre-rendered page image for it. The reader treats a missing image as "not ready yet"
  // and paints the real page as soon as pdf.js has it.
  if (isUploadPdfName(filename)) {
    return Response.json({ error: "no preview for uploads" }, { status: 404 });
  }

  const page = Math.max(1, Number(sp.get("page")) || 1);

  const params: Record<string, string> = {
    filename,
    page: String(page),
  };
  for (const key of ["width", "quality"] as const) {
    const value = sp.get(key);
    if (value) {
      params[key] = value;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchPdfAsset("pdf_page", params, {
      ifNoneMatch: request.headers.get("if-none-match"),
    });
  } catch {
    return Response.json({ error: "pdf server unreachable" }, { status: 502 });
  }

  if (!(upstream.ok || upstream.status === 304)) {
    return Response.json(
      { error: "page unavailable" },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  const headers = new Headers();
  for (const key of PASS_THROUGH) {
    const value = upstream.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }
  const body = upstream.status === 304 ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}
