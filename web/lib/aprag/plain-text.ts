// Turning a rendered answer back into text you can paste somewhere else.
//
// The answer travels as markdown carrying the model's numeric passage citations ([17]),
// and the app rewrites those into APA in-text cites and a reference list at render time.
// Copying the raw part text therefore hands over neither what the reader sees nor
// anything they can use: "**1,500 ms** … [17][18]". This rebuilds the presented text —
// same citation rewriting, markdown flattened, references appended.

import {
  citationsInsideSentence,
  disambiguationLetters,
  normalizeMath,
  rewriteIntext,
  setApaLetter,
  setIntextLetter,
  stripReferencesSection,
} from "./citations";
import type { CiteRef } from "./citations";
import { sanitizeText } from "../utils";
import type { RagReference, RagRetrieval } from "./types";

const CODE_FENCE = /^```[^\n]*\n?|```$/gm;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const HEADING = /^#{1,6}[ \t]+/gm;
const BLOCKQUOTE = /^>[ \t]?/gm;
const RULE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;
const BULLET = /^([ \t]*)[*+-][ \t]+/gm;
const EMPHASIS = /(\*\*\*|\*\*|\*|___|__|_)(?=\S)([\s\S]*?\S)\1/g;
const INLINE_CODE = /`([^`]+)`/g;
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!>])/g;
const BLANK_RUN = /\n{3,}/g;

/** Markdown → readable plain text: what the page shows, minus the formatting syntax. */
export function markdownToPlainText(markdown: string): string {
  let out = markdown ?? "";
  out = out.replace(CODE_FENCE, "");
  out = out.replace(IMAGE, "$1");
  out = out.replace(LINK, "$1");
  out = out.replace(HEADING, "");
  out = out.replace(BLOCKQUOTE, "");
  out = out.replace(RULE, "");
  out = out.replace(BULLET, "$1• ");
  out = out.replace(INLINE_CODE, "$1");
  // Emphasis can nest ("**bold *and* italic**"), so unwrap until it stops changing.
  let previous: string | null = null;
  while (previous !== out) {
    previous = out;
    out = out.replace(EMPHASIS, "$2");
  }
  out = out.replace(ESCAPED, "$1");
  return out.replace(BLANK_RUN, "\n\n").trim();
}

/** The APA reference list as plain text, numbered the way the page numbers it. */
export function referencesToPlainText(references: RagReference[]): string {
  if (references.length === 0) {
    return "";
  }
  const lines = references.map(
    (ref, i) => `[${i + 1}] ${markdownToPlainText(ref.apa || ref.filename)}`
  );
  return `References\n\n${lines.join("\n\n")}`;
}

/**
 * What the copy button should put on the clipboard: the answer as presented — APA in-text
 * citations instead of passage numbers, no markdown syntax — followed by the references
 * it cites. `text` is the raw assistant text; `retrieval` the payload rendered with it.
 */
export function answerToPlainText(
  text: string,
  retrieval?: RagRetrieval
): string {
  const source = stripReferencesSection(sanitizeText(text ?? ""));
  if (!retrieval) {
    return markdownToPlainText(source);
  }

  // Rebuild the passage → paper map exactly as the message does.
  const refById = new Map<string, RagReference>(
    retrieval.references.map((r) => [r.reference_id, r])
  );
  const byCiteIndex = new Map<number, CiteRef>();
  for (const chunk of retrieval.chunks) {
    const ref = chunk.reference_id ? refById.get(chunk.reference_id) : undefined;
    if (chunk.citeIndex != null && ref) {
      byCiteIndex.set(chunk.citeIndex, {
        referenceId: ref.reference_id,
        intext: ref.intext,
      });
    }
  }

  const citedIds = new Set<string>();
  for (const m of source.matchAll(/\[[ \t]*\d+(?:[ \t]*[,;][ \t]*\d+)*[ \t]*\]/g)) {
    for (const n of m[0].matchAll(/\d+/g)) {
      const ref = byCiteIndex.get(Number(n[0]));
      if (ref) {
        citedIds.add(ref.referenceId);
      }
    }
  }
  const cited = retrieval.references.filter((r) => citedIds.has(r.reference_id));

  // Year letters depend on which papers are cited together — see disambiguationLetters.
  const letters = disambiguationLetters(cited);
  const references = cited.map((r) => {
    const letter = letters.get(r.reference_id) ?? "";
    return {
      ...r,
      intext: setIntextLetter(r.intext, letter),
      apa: setApaLetter(r.apa, letter),
    };
  });
  for (const [idx, ref] of byCiteIndex) {
    byCiteIndex.set(idx, {
      ...ref,
      intext: setIntextLetter(ref.intext, letters.get(ref.referenceId) ?? ""),
    });
  }

  const body = markdownToPlainText(
    rewriteIntext(citationsInsideSentence(normalizeMath(source)), byCiteIndex)
  );
  const refBlock = referencesToPlainText(references);
  return refBlock ? `${body}\n\n${refBlock}` : body;
}
