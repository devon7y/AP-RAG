// Shapes returned by the AP-RAG query server (query_server.py) /retrieve endpoint,
// mirrored on the client so the chat route and the message renderer agree.

export type RagReference = {
  reference_id: string;
  file_path: string;
  apa: string; // full APA7 reference-list entry (server-formatted)
  intext: string; // APA7 in-text core, e.g. "Smith et al., 2019"
  filename: string;
  drive_url: string; // Google Drive webViewLink ("" until drive_links.json is built)
  hades_path: string;
  pages: number[]; // PDF pages the cited passages came from ([] for a pre-page-aware store)
  date?: string; // earliest-appearance date "YYYY[-MM[-DD]]" (server-supplied; "" if none)
  date_precision?: string; // "day" | "month" | "year" | ""
};

export type RagChunk = {
  content: string;
  file_path: string;
  chunk_id: string;
  reference_id?: string;
  score?: number | null;
  page?: number; // this chunk's own PDF page (server-stamped when page-aware)
  citeIndex?: number; // 1-based passage number used in the synthesis context (answer mode)
  bucketLabel?: string; // Research Digest: the time bucket this chunk's paper falls in
};

export type RagEntity = {
  entity_name: string;
  entity_type: string;
  description?: string;
};

export type RagRelationship = {
  src_id: string;
  tgt_id: string;
  description?: string;
};

// Metadata filters (AND across dimensions, OR within a list) resolved against the
// papers manifest server-side. Snake_case to match the server's Filters model.
export type RagFilters = {
  authors?: string[];
  year?: number;
  years?: number[]; // discrete years (e.g. "2025 and 2026") — match any
  year_from?: number;
  year_to?: number;
  date_from?: string; // "YYYY" | "YYYY-MM" | "YYYY-MM-DD" — precision-aware window (Research Digest)
  date_to?: string;
  journals?: string[];
  subjects?: string[];
  keywords?: string[];
  affiliations?: string[];
  types?: string[]; // record types (article/book/…) — used by the Papers Database, not chat chips
};

// ── Papers Database (/papers) shapes ──────────────────────────────────────────

export type PaperAuthor = { family?: string; given?: string };

// One slim table row from the query server's GET /papers (abstract & affiliations
// stay in the detail record). `pages` here is the bib record's page range string.
export type PaperRow = {
  filename: string;
  title: string;
  authors: PaperAuthor[];
  year: string;
  date: string;
  date_precision: string;
  container_title: string;
  volume: string;
  issue: string;
  pages: string | number[]; // bib page-range string; matched PDF pages (array) in deep-search rows
  doi: string;
  type: string;
  publisher: string;
  keywords: string[];
  subjects: string[];
  source: string;
  apa: string;
  intext: string;
  drive_url: string;
};

export type PaperListResponse = {
  papers: PaperRow[];
  total: number;
  offset: number;
  limit: number;
};

// A POST /search hit enriched with the slim bib fields — the deep-search table row.
export type RankedPaper = PaperRow & {
  score: number;
  n_chunks: number;
  snippet: string;
};

// Full manifest record for the detail drawer (GET /paper) — slim fields plus the
// heavyweight/provenance ones.
export type PaperDetail = PaperRow & {
  abstract?: string;
  affiliations?: string[];
  editors?: PaperAuthor[];
  hades_path?: string;
  date_source?: string;
  date_flag?: string;
  year_flag?: string;
  disambig?: string;
};

// The retrieval payload attached to an assistant message as a `data-retrieval` part.
// Carries everything the UI needs to render references, inline citations, and (in
// chunk mode) the raw chunk cards — and to re-render them on reload.
export type RagRetrieval = {
  query: string; // the (condensed) standalone query actually retrieved on
  mode: string; // retrieval mode the server used
  chunkMode: boolean; // raw-chunk view vs synthesized answer
  references: RagReference[];
  chunks: RagChunk[];
  entities: RagEntity[];
  relationships: RagRelationship[];
  // The metadata filters actually applied this turn (manual + client-previewed + the
  // server's second-pass extraction, minus any the user dismissed). The client syncs its
  // active filter chips to this.
  appliedFilters?: RagFilters | null;
};
