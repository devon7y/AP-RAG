import { auth } from "@/app/(auth)/auth";
import { locatePdfQuote } from "@/lib/aprag/client";

// Where does a cited passage actually sit in the PDF? The corpus store carries no
// per-chunk page numbers, so the reader recovers the page (and the highlight boxes) by
// searching the PDF text itself on the PC. A miss is a normal answer, not an error.

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { filename?: string; quote?: string; hintPage?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const filename = body.filename?.trim();
  const quote = body.quote?.trim();
  if (!(filename?.toLowerCase().endsWith(".pdf") && quote)) {
    return Response.json(
      { error: "filename and quote required" },
      { status: 400 }
    );
  }

  try {
    return Response.json(
      await locatePdfQuote({ filename, quote, hintPage: body.hintPage })
    );
  } catch {
    // Fall back to "not found" so the reader still opens the paper.
    return Response.json({ page: null, rects: [], unavailable: true });
  }
}
