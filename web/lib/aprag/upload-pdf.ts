import "server-only";

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

export type PdfReadFailure = "encrypted" | "corrupt" | "empty" | "unavailable";

export class PdfReadError extends Error {
  readonly reason: PdfReadFailure;

  constructor(reason: PdfReadFailure, message: string) {
    super(message);
    this.reason = reason;
    this.name = "PdfReadError";
  }
}

/**
 * A 2D-affine stand-in for the browser's DOMMatrix, installed before pdf.js loads.
 *
 * pdf.js evaluates `new DOMMatrix()` at module scope. In Node it expects to polyfill that
 * from @napi-rs/canvas, which it pulls in through `createRequire` — a call no bundler can
 * see, so the package is traced out of the deployed function and the module throws
 * "DOMMatrix is not defined" on import. Shipping a platform-specific native binary to fix
 * that is a lot of machinery for something this route never uses: it reads a text layer
 * and rasterizes nothing, and the matrix only matters for rendering.
 *
 * Defining the global first also stops pdf.js reaching for canvas at all. The arithmetic
 * here is real (an incorrect matrix would be worse than a missing one), just limited to
 * the 2D affine case pdf.js works in.
 */
class AffineDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string | AffineDOMMatrix) {
    if (Array.isArray(init)) {
      if (init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
      return;
    }
    if (init && typeof init === "object") {
      const { a, b, c, d, e, f } = init;
      Object.assign(this, { a, b, c, d, e, f });
    }
  }

  get is2D() {
    return true;
  }

  get isIdentity() {
    return (
      this.a === 1 &&
      this.b === 0 &&
      this.c === 0 &&
      this.d === 1 &&
      this.e === 0 &&
      this.f === 0
    );
  }

  /** this = this × other */
  multiplySelf(other: AffineDOMMatrix): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * other.a + c * other.b;
    this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d;
    this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e;
    this.f = b * other.e + d * other.f + f;
    return this;
  }

  /** this = other × this */
  preMultiplySelf(other: AffineDOMMatrix): this {
    const { a, b, c, d, e, f } = other;
    const m = new AffineDOMMatrix([a, b, c, d, e, f]).multiplySelf(this);
    return Object.assign(this, {
      a: m.a,
      b: m.b,
      c: m.c,
      d: m.d,
      e: m.e,
      f: m.f,
    });
  }

  translateSelf(tx = 0, ty = 0): this {
    this.e += this.a * tx + this.c * ty;
    this.f += this.b * tx + this.d * ty;
    return this;
  }

  translate(tx = 0, ty = 0): AffineDOMMatrix {
    return new AffineDOMMatrix(this).translateSelf(tx, ty);
  }

  scaleSelf(sx = 1, sy = sx): this {
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
    return this;
  }

  scale(sx = 1, sy = sx): AffineDOMMatrix {
    return new AffineDOMMatrix(this).scaleSelf(sx, sy);
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (det === 0) {
      // What the platform does with a singular matrix: mark it non-invertible.
      return Object.assign(this, {
        a: Number.NaN,
        b: Number.NaN,
        c: Number.NaN,
        d: Number.NaN,
        e: Number.NaN,
        f: Number.NaN,
      });
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  toString(): string {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

/** Install the stand-ins pdf.js expects a browser to provide. Idempotent. */
function ensureDomGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.DOMMatrix ??= AffineDOMMatrix;
}

/**
 * Where pdf.js's worker module sits, as a file:// URL.
 *
 * The copy under lib/pdfjs is checked in (`pnpm sync-pdfjs-worker`, same as the browser
 * one under public/) and is the one that can be relied on: it is a plain file inside the
 * app, so it ships with the function whatever the host does to node_modules — installing
 * flat, symlinking a pnpm store, or dereferencing those symlinks while packaging. The
 * node_modules copy is tried first anyway, since in a normal checkout it is guaranteed to
 * match the installed pdfjs-dist.
 */
function resolveWorkerSrc(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(
      createRequire(import.meta.url).resolve(
        "pdfjs-dist/legacy/build/pdf.worker.mjs"
      )
    );
  } catch {
    /* not resolvable from here — the vendored copy below is the answer */
  }
  candidates.push(join(process.cwd(), "lib/pdfjs/pdf.worker.min.mjs"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  console.error("pdf.js worker module not found; tried:", candidates);
  return null;
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
  // Before the import: pdf.js touches DOMMatrix while its module body runs.
  ensureDomGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js parses in a worker module it imports at runtime. Left to itself it derives that
  // path from its own module URL, which survives neither bundling nor deployment; resolved
  // through node_modules it is the same file the build was told to ship (see
  // outputFileTracingIncludes in next.config.ts). Best-effort: if this cannot be resolved,
  // pdf.js still gets to try its own way.
  const workerSrc = resolveWorkerSrc();
  if (workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
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
    // "The reader didn't start" and "your file is broken" are different problems and want
    // different words: one is ours to fix and retrying won't help, the other is the file.
    console.error("pdf.js could not open an uploaded PDF:", error);
    const message = String((error as { message?: string }).message ?? "");
    if (/worker/i.test(message)) {
      throw new PdfReadError(
        "unavailable",
        "The PDF reader failed to start on the server, so this paper couldn't be read. Nothing is wrong with your file."
      );
    }
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
