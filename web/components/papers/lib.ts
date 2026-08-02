import type { PaperAuthor, PaperRow, RagFilters } from "@/lib/aprag/types";

// Pure helpers for the Papers Database page: URL ⇄ state serialization (the URL is the
// single source of truth, so filtered/sorted views are shareable), display formatting,
// and a plain fetcher (the API routes return `{error}` bodies, not ChatbotError codes).

export type SortOrder = "asc" | "desc";

export type PapersQuery = {
  q: string; // instant quick match (title/author/journal/DOI/filename tokens)
  deep: string; // semantic deep-search query ("" = browse mode)
  similar: string; // "related to this paper" mode — a filename ("" = off)
  sort: string;
  order: SortOrder;
  page: number; // 0-based
  per: number;
  filters: RagFilters | null;
};

export const PER_CHOICES = [25, 50, 100, 200, 500, 1000] as const;

export const DEFAULT_QUERY: PapersQuery = {
  q: "",
  deep: "",
  similar: "",
  sort: "year",
  order: "desc",
  page: 0,
  per: 100,
  filters: null,
};

export const LIST_FILTER_KEYS = [
  "authors",
  "journals",
  "subjects",
  "keywords",
  "affiliations",
  "types",
] as const;

export type ListFilterKey = (typeof LIST_FILTER_KEYS)[number];

export const FILTER_LABEL: Record<ListFilterKey, string> = {
  authors: "Author",
  journals: "Journal",
  subjects: "Subject",
  keywords: "Keyword",
  affiliations: "Affiliation",
  types: "Type",
};

const SORT_KEYS = new Set(["title", "first_author", "year", "date", "journal"]);

type ParamsLike = {
  get(name: string): string | null;
  getAll(name: string): string[];
};

export function parsePapersQuery(sp: ParamsLike): PapersQuery {
  const filters: RagFilters = {};
  for (const k of LIST_FILTER_KEYS) {
    const values = sp.getAll(k).filter(Boolean);
    if (values.length > 0) {
      filters[k] = values;
    }
  }
  for (const k of ["year_from", "year_to"] as const) {
    const v = Number(sp.get(k));
    if (Number.isInteger(v) && v > 0) {
      filters[k] = v;
    }
  }

  const sort = sp.get("sort") ?? DEFAULT_QUERY.sort;
  const per = Number(sp.get("per"));
  return {
    q: sp.get("q") ?? "",
    deep: sp.get("deep") ?? "",
    similar: sp.get("similar") ?? "",
    sort: SORT_KEYS.has(sort) ? sort : DEFAULT_QUERY.sort,
    order: sp.get("order") === "asc" ? "asc" : "desc",
    page: Math.max(0, (Number(sp.get("page")) || 1) - 1), // 1-based in the URL
    per: (PER_CHOICES as readonly number[]).includes(per)
      ? per
      : DEFAULT_QUERY.per,
    filters: Object.keys(filters).length > 0 ? filters : null,
  };
}

function appendFilters(sp: URLSearchParams, filters: RagFilters | null): void {
  if (!filters) {
    return;
  }
  for (const k of LIST_FILTER_KEYS) {
    for (const v of filters[k] ?? []) {
      sp.append(k, v);
    }
  }
  if (filters.year_from != null) {
    sp.set("year_from", String(filters.year_from));
  }
  if (filters.year_to != null) {
    sp.set("year_to", String(filters.year_to));
  }
}

// The page URL query string (omits defaults so plain /papers stays clean).
export function papersQueryString(q: PapersQuery): string {
  const sp = new URLSearchParams();
  if (q.q) {
    sp.set("q", q.q);
  }
  if (q.deep) {
    sp.set("deep", q.deep);
  }
  if (q.similar) {
    sp.set("similar", q.similar);
  }
  if (q.sort !== DEFAULT_QUERY.sort) {
    sp.set("sort", q.sort);
  }
  if (q.order !== DEFAULT_QUERY.order) {
    sp.set("order", q.order);
  }
  if (q.page > 0) {
    sp.set("page", String(q.page + 1));
  }
  if (q.per !== DEFAULT_QUERY.per) {
    sp.set("per", String(q.per));
  }
  appendFilters(sp, q.filters);
  return sp.toString();
}

// The /api/papers query string for a browse fetch (offset/limit resolved from page/per).
export function apiListQueryString(
  q: PapersQuery,
  override?: { offset?: number; limit?: number }
): string {
  const sp = new URLSearchParams();
  if (q.q.trim()) {
    sp.set("q", q.q.trim());
  }
  sp.set("sort", q.sort);
  sp.set("order", q.order);
  sp.set("offset", String(override?.offset ?? q.page * q.per));
  sp.set("limit", String(override?.limit ?? q.per));
  appendFilters(sp, q.filters);
  return sp.toString();
}

export function countActiveFilters(filters: RagFilters | null): number {
  if (!filters) {
    return 0;
  }
  let n = 0;
  for (const k of LIST_FILTER_KEYS) {
    n += (filters[k] ?? []).length;
  }
  if (filters.year_from != null || filters.year_to != null) {
    n += 1;
  }
  return n;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function displayTitle(
  row: Pick<PaperRow, "title" | "filename">
): string {
  return row.title.trim() || row.filename.replace(/\.pdf$/i, "");
}

export function fullAuthorList(authors: PaperAuthor[]): string {
  return authors
    .map((a) => [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

// Compact author display: "Westbury" / "Westbury & Hollis" / "Smith et al."
export function compactAuthors(authors: PaperAuthor[]): string {
  const families = authors.map((a) => a.family ?? "").filter(Boolean);
  if (families.length === 0) {
    return "";
  }
  if (families.length === 1) {
    return families[0];
  }
  if (families.length === 2) {
    return `${families[0]} & ${families[1]}`;
  }
  return `${families[0]} et al.`;
}

// "78(3), 461–505" from whichever of volume/issue/pages exist.
export function volIssuePages(row: PaperRow): string {
  const pages = typeof row.pages === "string" ? row.pages : "";
  let out = row.volume;
  if (row.issue) {
    out += `(${row.issue})`;
  }
  if (pages) {
    out += out ? `, ${pages}` : pages;
  }
  return out;
}

// Plain JSON fetcher for the papers API routes (their error bodies are `{error}`).
export async function paperFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}
