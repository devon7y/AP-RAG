# Chunk-size A/B eval (Chroma methodology)

Decides `CHUNK_TARGET_TOKENS` / `CHUNK_OVERLAP_TOKENS` empirically for the
**production Qwen3-Embedding-8B** embedder + an academic-paper corpus, before
committing to an expensive full reingest. It also compares the structure-aware
`scientific_chunker` against the generic fixed-token and recursive baselines
(the "scientific vs Fix/Recursive" TODO).

**Methodology = Chroma's** "Evaluating Chunking Strategies for Retrieval":
chunks are bounding boxes over the source; we report token/character-span
**Recall, Precision, IoU** at retrieval k=5 and k=10. Where installed, we use
Chroma's *own* `chunking_evaluation` code (FixedTokenChunker, RecursiveTokenChunker,
`rigorous_document_search`); the metric formulas are replicated verbatim. The one
thing wrapped is **retrieval**, which uses our production **asymmetric** embedding
(query instruction on questions, none on chunks) — so results reflect how AP-RAG
actually retrieves. See `run_eval.py` for the faithful-harness rationale.

## What's A/B tested
- **Size** (primary): scientific chunker at target **256 / 384 / 512 / 800**
  (current = 800), with max/min scaled to the production ratios.
- **Overlap** (secondary): scientific chunker at 512 with overlap **0 / 51 / 96**.
- **Chunker type**: `scientific` vs `fixed` vs `recursive` at each size.

## Pipeline
1. **LOCAL** — extract text (matches ingest's pypdf + `\f` page joins):
   ```
   python scripts/chunk_eval/extract_corpus.py \
       --papers /Users/devon7y/VS_Code/semanticfa/papers \
       --out scripts/chunk_eval/corpus.jsonl
   ```
2. **LOCAL** — generate the synthetic QA set (OPENAI_API_KEY stays on the Mac):
   ```
   python scripts/chunk_eval/gen_questions.py \
       --corpus scripts/chunk_eval/corpus.jsonl \
       --out scripts/chunk_eval/qa.jsonl --per-doc 5
   ```
3. **FIR** — ship `pipeline/`, `scripts/chunk_eval/`, `corpus.jsonl`, `qa.jsonl`
   to `$WORKDIR/` and `$WORKDIR/chunk_eval/`, then:
   ```
   sbatch slurm/job_chunk_eval.slurm     # 1 H100 MIG, BF16; ~15-30 min
   # (the job runs: PYTHONPATH=$WORKDIR python $WORKDIR/scripts/chunk_eval/run_eval.py …)
   ```
   Output: `$WORKDIR/chunk_eval/results.json` + a markdown table in the log.

## Caveats (read before acting on numbers)
- Measures **chunk geometry + retrieval**, NOT end-to-end answer quality, and
  does NOT include the contextual-retrieval blurb (orthogonal to size).
- The scientific chunker is located by its `raw_text_without_overlap` core so
  chunks tile the document; furniture-stripped chunks use an anchor fallback
  (`locate_miss_pct` in the output flags any that couldn't be located).
- Optimal size is corpus/embedder-dependent; this answers it for *this* corpus
  and *our* embedder.
