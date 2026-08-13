// An uploaded paper's bibliographic identity: a model's reading of the front matter,
// turned into the APA7 forms the rest of the app already speaks.
//
// A paper cited as "(Adams & Delaney, 2023)" reads like a paper; one cited as
// "draft_v3_FINAL.pdf" reads like a file. The corpus gets these fields from the manifest,
// formatted by apa_citations.py on the query server; an uploaded paper has no manifest
// entry, so the same two strings — the reference-list entry and the in-text core — are
// built here. Pure, so the shapes can be exercised without a model in the loop.

export type PaperIdentity = {
  title: string;
  apa: string; // reference-list entry
  intext: string; // "Smith et al., 2019"
  year: string;
};

export type ExtractedAuthor = { family?: string; given?: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** Author list from the model's JSON, tolerating plain strings instead of objects. */
export function parseAuthors(v: unknown): ExtractedAuthor[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v
    .map((a) => {
      if (typeof a === "string") {
        // "Smith, J." — comma form names the family first; "Jane Smith" does not.
        const parts = a.replace(/\s+/g, " ").trim().split(/,\s*/);
        if (parts.length > 1) {
          return { family: parts[0], given: parts[1] };
        }
        const words = parts[0].split(" ");
        return {
          family: words.at(-1) ?? "",
          given: words.slice(0, -1).join(" "),
        };
      }
      const o = a as Record<string, unknown>;
      return { family: str(o.family), given: str(o.given) };
    })
    .filter((a) => a.family)
    .slice(0, 30);
}

/** "Jane Marie Smith" → "Smith, J. M." */
function apaName(a: ExtractedAuthor): string {
  const initials = (a.given ?? "")
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(" ");
  return initials ? `${a.family}, ${initials}` : (a.family ?? "");
}

/** APA7 author list: up to 20 names, then an ellipsis and the last one. */
function apaAuthors(list: ExtractedAuthor[]): string {
  const names = list.map(apaName).filter(Boolean);
  if (names.length === 0) {
    return "";
  }
  if (names.length === 1) {
    return names[0];
  }
  if (names.length <= 20) {
    return `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  }
  return `${names.slice(0, 19).join(", ")}, . . . ${names.at(-1)}`;
}

/** APA7 in-text core: "Smith, 2019" / "Smith & Jones, 2019" / "Smith et al., 2019". */
function apaIntext(list: ExtractedAuthor[], year: string): string {
  const families = list.map((a) => a.family).filter(Boolean) as string[];
  const y = year || "n.d.";
  if (families.length === 0) {
    return "";
  }
  if (families.length === 1) {
    return `${families[0]}, ${y}`;
  }
  if (families.length === 2) {
    return `${families[0]} & ${families[1]}, ${y}`;
  }
  return `${families[0]} et al., ${y}`;
}

/** The reference-list entry. Markdown italics, as the reference list renders markdown. */
function apaEntry(
  list: ExtractedAuthor[],
  fields: {
    year: string;
    title: string;
    journal: string;
    volume: string;
    issue: string;
    pages: string;
    doi: string;
  }
): string {
  const parts: string[] = [];
  const who = apaAuthors(list);
  if (who) {
    parts.push(`${who.replace(/\.$/, "")}.`);
  }
  parts.push(`(${fields.year || "n.d."}).`);
  if (fields.title) {
    parts.push(/[.?!]$/.test(fields.title) ? fields.title : `${fields.title}.`);
  }
  if (fields.journal) {
    let source = `*${fields.journal}*`;
    if (fields.volume) {
      source += `, *${fields.volume}*`;
      if (fields.issue) {
        source += `(${fields.issue})`;
      }
    }
    if (fields.pages) {
      source += `, ${fields.pages}`;
    }
    parts.push(`${source}.`);
  }
  if (fields.doi) {
    const doi = fields.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    parts.push(`https://doi.org/${doi}`);
  }
  return parts.join(" ").trim();
}

/** The file name as a last-resort label: "Smith_Etal_2019.pdf" → "Smith Etal 2019". */
export function labelFromFilename(filename: string): string {
  return (
    filename
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || filename
  );
}

/** What an unidentifiable paper is called: its own file name. */
export function identityFallback(filename: string): PaperIdentity {
  const label = labelFromFilename(filename);
  return { title: label, apa: "", intext: label, year: "" };
}

/**
 * A parsed bibliographic record → the identity stored with the paper. A record with
 * neither a title nor an author is not an identification, so it falls back to the file
 * name rather than producing "(n.d.)" citations.
 */
export function identityFromRecord(
  record: Record<string, unknown>,
  filename: string
): PaperIdentity {
  const fallback = identityFallback(filename);
  const list = parseAuthors(record.authors);
  const title = str(record.title);
  const year = /^\d{4}$/.test(str(record.year)) ? str(record.year) : "";
  if (!(title || list.length > 0)) {
    return fallback;
  }
  return {
    title: title || fallback.title,
    apa: apaEntry(list, {
      year,
      title,
      journal: str(record.journal),
      volume: str(record.volume),
      issue: str(record.issue),
      pages: str(record.pages),
      doi: str(record.doi),
    }),
    intext: apaIntext(list, year) || title || fallback.intext,
    year,
  };
}
