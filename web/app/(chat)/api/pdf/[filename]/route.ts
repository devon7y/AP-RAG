import { auth } from "@/app/(auth)/auth";
import { fetchPdfAsset } from "@/lib/aprag/client";

// Streams one corpus PDF from the always-on PC to the in-app viewer, behind the app's
// own login (the tunnel URL and API key never reach the browser). The filename rides in
// the path rather than a query param so pdf.js, the browser cache, and "pop out" all see
// a stable, sensible URL.
//
// Range and conditional headers are forwarded and the upstream status (206/304) is
// passed through verbatim — pdf.js depends on partial responses to avoid pulling whole
// multi-megabyte files for one page.

const PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
  "content-disposition",
];

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
