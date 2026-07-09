import Papa from "papaparse";
import type { PaperListResponse, PaperRow } from "@/lib/aprag/types";
import { apiListQueryString, type PapersQuery, paperFetcher } from "./lib";

// Client-side export of the CURRENT filtered set (browse mode pages through the API;
// deep mode exports the ranked list already in memory).

const PAGE = 1000; // server max per request
const EXPORT_CAP = 10_000; // corpus is ~10k; guard against runaway loops all the same

export async function fetchAllRows(
  query: PapersQuery,
  onProgress?: (fetched: number, total: number) => void
): Promise<PaperRow[]> {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const rows: PaperRow[] = [];
  let total = Number.POSITIVE_INFINITY;
  while (rows.length < Math.min(total, EXPORT_CAP)) {
    const qs = apiListQueryString(query, { offset: rows.length, limit: PAGE });
    const data = await paperFetcher<PaperListResponse>(
      `${base}/api/papers?${qs}`
    );
    total = data.total;
    if (data.papers.length === 0) {
      break;
    }
    rows.push(...data.papers);
    onProgress?.(rows.length, Math.min(total, EXPORT_CAP));
  }
  return rows;
}

function joinAuthors(row: PaperRow): string {
  return row.authors
    .map((a) => [a.family, a.given].filter(Boolean).join(", "))
    .join("; ");
}

export function rowsToCsv(rows: PaperRow[]): string {
  return Papa.unparse(
    rows.map((r) => ({
      filename: r.filename,
      title: r.title,
      authors: joinAuthors(r),
      year: r.year,
      date: r.date,
      journal: r.container_title,
      volume: r.volume,
      issue: r.issue,
      pages: typeof r.pages === "string" ? r.pages : r.pages.join(", "),
      doi: r.doi,
      type: r.type,
      publisher: r.publisher,
      keywords: r.keywords.join("; "),
      subjects: r.subjects.join("; "),
      source: r.source,
    }))
  );
}

const BIB_TYPE: Record<string, string> = {
  article: "article",
  book: "book",
  chapter: "incollection",
  thesis: "phdthesis",
  report: "techreport",
};

function bibEscape(value: string): string {
  return value.replace(/[{}]/g, "").replace(/([&%$#_])/g, "\\$1");
}

function bibKey(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9_-]/g, "");
}

export function rowsToBibtex(rows: PaperRow[]): string {
  const entries = rows.map((r) => {
    const type = BIB_TYPE[r.type] ?? "misc";
    const fields: [string, string][] = [];
    const authors = r.authors
      .map((a) => [a.family, a.given].filter(Boolean).join(", "))
      .filter(Boolean)
      .join(" and ");
    if (authors) {
      fields.push(["author", bibEscape(authors)]);
    }
    if (r.title) {
      fields.push(["title", `{${bibEscape(r.title)}}`]);
    }
    if (r.container_title) {
      fields.push([
        type === "incollection" ? "booktitle" : "journal",
        bibEscape(r.container_title),
      ]);
    }
    if (r.year) {
      fields.push(["year", r.year]);
    }
    if (r.volume) {
      fields.push(["volume", bibEscape(r.volume)]);
    }
    if (r.issue) {
      fields.push(["number", bibEscape(r.issue)]);
    }
    if (typeof r.pages === "string" && r.pages) {
      fields.push(["pages", bibEscape(r.pages)]);
    }
    if (r.publisher) {
      fields.push(["publisher", bibEscape(r.publisher)]);
    }
    if (r.doi) {
      fields.push(["doi", r.doi]);
    }
    if (r.keywords.length > 0) {
      fields.push(["keywords", bibEscape(r.keywords.join(", "))]);
    }
    const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
    return `@${type}{${bibKey(r.filename)},\n${body}\n}`;
  });
  return `${entries.join("\n\n")}\n`;
}

export function downloadFile(
  name: string,
  content: string,
  mime: string
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
