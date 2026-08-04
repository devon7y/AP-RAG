export interface Paper {
  file: string;
  title: string;
  authors: string;
  year: number;
  journal: string;
  doi: string;
  abstract: string;
  /** ordered APA names ("Chau, G."), byline order as printed */
  authorsFull?: string[];
  centroid: [number, number];
  centroid3: [number, number, number];
  nChunks: number;
}

export interface Cluster {
  id: number;
  size: number;
  nPapers: number;
  center: [number, number];
  center3: [number, number, number];
  terms: string[];
  sampleTitles: string[];
  name: string;
  flavor: string;
}

export interface AtlasData {
  n: number;
  /** [0,1] normalized, flat [x0,y0,x1,y1,...] */
  pos2: Float32Array;
  /** [0,1] normalized, flat xyz */
  pos3: Float32Array;
  cluster: Int16Array;
  paper: Int32Array;
  year: Int16Array;
  /** Chunk ids are stored split rather than as 445k strings: `docIdx` indexes
   *  `docHashes` and `chunkNum` is the suffix, so an id costs 8 bytes instead of
   *  ~45, and the full table never has to be materialised. Rebuild one with
   *  chunkIdOf(); go the other way with the corpus chunk index. */
  docIdx: Int32Array;
  chunkNum: Int32Array;
  docHashes: string[];
}

export interface KnnGraph {
  k: number;
  /** flat [n*k] neighbor indices */
  idx: Int32Array;
  /** flat [n*k] cosine similarities */
  sim: Float32Array;
}

export interface Entity {
  id: string;
  type: string;
  desc: string;
  deg: number;
  nChunks: number;
  pos2: [number, number];
  pos3: [number, number, number];
  chunkIdx: number[];
}

export interface KgEdge {
  s: string;
  t: string;
  w: number;
  desc: string;
  kw: string;
}

export interface Constellations {
  entities: Entity[];
  edges: KgEdge[];
}

export interface GhostPaper {
  title: string;
  fields: string;
  methods: string;
  abstract: string;
  /** ordered APA names ("Chau, G."), byline order as printed */
  authorsFull?: string[];
  marker: "GHOST";
}

export interface VoidSite {
  pos: [number, number];
  area: number;
  nearClusters: number[];
  /** clean neighbor paper titles (no raw passage prose) */
  neighbors: string[];
  ghost: GhostPaper;
}

/** One disambiguated author (full name variants merged by family + initial). */
export interface AuthorRec {
  name: string;
  family: string;
  /** indices into papers.json */
  papers: number[];
  /** oeuvre centroid on the map, [0,1]² / [0,1]³ */
  pos2: [number, number];
  pos3: [number, number, number];
}

/** Per-paper APA extras, arrays parallel to papers.json order. */
export interface PaperMeta {
  keywords: string[][];
  subjects: string[][];
  affil: string[][];
  /** first author per paper — index into authors.json, -1 unknown */
  first: number[];
  /** Google Drive webViewLink per paper ("" when unmapped) */
  drive: string[];
  /** publication date as a fractional year (mid-month/mid-year conventions;
   *  0 = unknown) — the time machine's fine-grained clock */
  frac: number[];
  /** human display date ("Mar 14, 2025" / "Mar 2025" / "2025" / "") */
  dateStr: string[];
}

export interface ChunkText {
  text: string;
  section: string;
  page: number | null;
  file: string;
  qid: string;
}

export interface CorpusData {
  atlas: AtlasData;
  papers: Paper[];
  clusters: Cluster[];
  voids: VoidSite[];
  /** 512x512 float32 heightmap, row-major (y rows), values 0..1 */
  heightmap: Float32Array;
}
