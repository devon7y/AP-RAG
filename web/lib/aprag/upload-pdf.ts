import "server-only";

import { generateText } from "ai";
import { openaiOptions } from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import {
  identityFallback,
  identityFromRecord,
  type PaperIdentity,
} from "./upload-identity";
import type { UploadPage } from "./uploads";

// Reading an uploaded PDF: bytes → per-page text → who wrote it.
//
// The corpus pipeline extracts with PyMuPDF on HPC; here the same job has to happen inside
// a request, so it runs on pdf.js (already a dependency for the in-app reader) in Node.
// Page boundaries are preserved because the chunker uses them — to strip running heads and
// to stamp each passage with the page a reader can turn to.

/** Papers, not books: past this the file is something the chat has no business holding. */
const MAX_PAGES = 250;
/** Hard ceiling on extracted text, so a pathological file can't exhaust the function. */
const MAX_CHARS = 1_500_000;

export class PdfReadError extends Error {
  readonly reason: "encrypted" | "corrupt" | "empty";

  constructor(reason: "encrypted" | "corrupt" | "empty", message: string) {
    super(message);
    this.reason = reason;
    this.name = "PdfReadError";
  }
}

/** A PDF starts with "%PDF-" — checked on the bytes, not on the declared MIME type. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const header = String.fromCharCode(...bytes.slice(0, 5));
  return header === "%PDF-";
}

export type ExtractedPdf = {
  pages: UploadPage[];
  pageCount: number; // pages in the document (may exceed pages.length — see MAX_PAGES)
  chars: number;
};

/**
 * Per-page text, in reading order. Fonts are deliberately not loaded (`useSystemFonts`
 * off, no standard-font data): nothing is rendered here, and the font machinery is the one
 * part of pdf.js that wants a filesystem in a serverless bundle.
 */
export async function extractPdfPages(
  bytes: Uint8Array
): Promise<ExtractedPdf> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is handed (it transfers it to its worker),
    // which would leave the caller holding a detached array — and the caller still has to
    // upload these exact bytes. Hand it a copy.
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true, // nothing is rendered here; only the text layer is read
    verbosity: 0, // errors only — missing standard fonts are irrelevant to text
  });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    const name = (error as { name?: string }).name;
    await task.destroy().catch(() => {
      /* nothing to tear down */
    });
    if (name === "PasswordException") {
      throw new PdfReadError(
        "encrypted",
        "This PDF is password-protected, so its text can't be read."
      );
    }
    // The user is told their file couldn't be read; the log says why, because "couldn't
    // read it" also covers pdf.js failing to start rather than the file being bad.
    console.error("pdf.js could not open an uploaded PDF:", error);
    throw new PdfReadError("corrupt", "This file could not be read as a PDF.");
  }

  const pages: UploadPage[] = [];
  let chars = 0;
  try {
    const limit = Math.min(doc.numPages, MAX_PAGES);
    for (let n = 1; n <= limit; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""
        )
        .join("");
      page.cleanup();
      pages.push({ page: n, text });
      chars += text.length;
      if (chars >= MAX_CHARS) {
        break;
      }
    }
    return { pages, pageCount: doc.numPages, chars };
  } finally {
    await task.destroy().catch(() => {
      /* best-effort */
    });
  }
}

// ── Who wrote it ─────────────────────────────────────────────────────────────
// A paper cited as "Smith et al. (2019)" reads like a paper; one cited as
// "draft_v3_FINAL.pdf" reads like a file. The front matter is put to a cheap model once,
// at upload time, and the result is stored — the answer path never pays for this.

const IDENTIFY_SYSTEM =
  "You read the first pages of an academic paper and report its bibliographic record. " +
  'Respond with ONLY a JSON object: "title" (string), "authors" (array of {"family", ' +
  '"given"} in the order they are listed), "year" (4-digit publication year as a string), ' +
  '"journal" (journal, conference or publisher — "" if unknown), "volume", "issue", ' +
  '"pages" (page range), "doi". Use "" for anything the text does not state; NEVER guess ' +
  "or invent a value, and never fill a field from your own knowledge of the literature. " +
  "The title is the paper's own title, not a running head, journal name or section " +
  "heading. Respond with the JSON object only — no prose, no code fences.";

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

/**
 * The paper's bibliographic identity, read off its opening pages. Best-effort by design:
 * an unreadable or unusual front page costs the paper its citation style, not its place in
 * the conversation — it is then cited by file name.
 */
export async function identifyPaper(
  frontMatter: string,
  filename: string
): Promise<PaperIdentity> {
  const text = frontMatter.slice(0, 6000).trim();
  if (!text) {
    return identityFallback(filename);
  }

  try {
    const { text: raw } = await generateText({
      model: getLanguageModel(),
      system: IDENTIFY_SYSTEM,
      prompt: `First pages of the PDF (file name: ${filename}):\n\n${text}\n\nJSON:`,
      // Mechanical extraction in front of an upload the user is waiting on.
      providerOptions: openaiOptions("none"),
      abortSignal: AbortSignal.timeout(30_000),
    });
    return identityFromRecord(safeParse(raw), filename);
  } catch {
    return identityFallback(filename);
  }
}
