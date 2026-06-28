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
};

export type RagChunk = {
  content: string;
  file_path: string;
  chunk_id: string;
  reference_id?: string;
  score?: number | null;
  page?: number; // this chunk's own PDF page (server-stamped when page-aware)
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
  year_from?: number;
  year_to?: number;
  journals?: string[];
  subjects?: string[];
  keywords?: string[];
  affiliations?: string[];
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
  // Metadata filters the LLM inferred from this turn's wording (explicit mentions only,
  // validated against the corpus). The client merges these into the active filter chips.
  inferredFilters?: RagFilters;
};
