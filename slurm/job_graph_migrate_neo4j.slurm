#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=graph_migrate_neo4j
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/graph_migrate_neo4j_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/graph_migrate_neo4j_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

# One-time GraphML → Neo4j import for the ingest graph store (Fix-graph,
# docs/INGEST_SCALING_BOTTLENECK.md Fix 1). CPU-only — no GPU, no vLLM.
#
# What it does: starts the Neo4j Apptainer sidecar (data persists on scratch at
# $WORKDIR/neo4j_aprag/), streams graph_chunk_entity_relation.graphml into it via
# LightRAG's own Neo4JStorage batch upserts (idempotent MERGE — safe to re-run
# after an interruption), verifies readback + node/edge counts, and stamps
# $STORAGE_DIR/.graph_backend=Neo4JStorage. After it succeeds, submit ingest
# cycles with --export=ALL,GRAPH_BACKEND=neo4j and the graph is never rewritten
# to GraphML again (measured import rate: 1.63M nodes ≈ 100s, 3.3M edges ≈ 10.5
# min — SCALING_ISSUES.md §7.7).
#
# Prereqs (once per cluster, from a login node — compute nodes may be offline):
#   apptainer pull /scratch/devon7y/westbury_rag/neo4j_5.26-community.sif docker://neo4j:5.26-community
#   (venv must exist: job_setup_env_<cluster>.slurm; it now installs the neo4j driver)
#
# Paths default to Nibi/Rorqual (/scratch/...). On Fir submit with:
#   sbatch --export=ALL,WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag \
#     --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/graph_migrate_neo4j_%j.out \
#     --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/graph_migrate_neo4j_%j.err \
#     slurm/job_graph_migrate_neo4j.slurm

WORKDIR=${WORKDIR:-/scratch/devon7y/westbury_rag}
VENV_DIR=${VENV_DIR:-$WORKDIR/venv}
export WORKDIR
export STORAGE_SUBDIR="${STORAGE_SUBDIR:-rag_storage_aprag}"
STORAGE_DIR="$WORKDIR/$STORAGE_SUBDIR"

mkdir -p "$WORKDIR/logs"

module load python/3.11 gcc/12.3 2>/dev/null || module load python/3.11

if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_<cluster>.slurm first."
    exit 1
fi
source "$VENV_DIR/bin/activate"

if [ ! -s "$STORAGE_DIR/graph_chunk_entity_relation.graphml" ]; then
    echo "[$(date)] ERROR: no GraphML at $STORAGE_DIR/graph_chunk_entity_relation.graphml"
    exit 1
fi
echo "[$(date)] Importing $(du -sh "$STORAGE_DIR/graph_chunk_entity_relation.graphml" | cut -f1) of GraphML into Neo4j..."

# ── Neo4j sidecar (data on scratch, survives this job) ────────────────────────
# GRAPH_BACKEND is forced here: this job IS the sanctioned NetworkX→Neo4j
# transition, so the marker guard is intentionally not consulted.
GRAPH_BACKEND=neo4j
if [ ! -f "$WORKDIR/slurm/neo4j_sidecar.sh" ]; then
    echo "[$(date)] FATAL: $WORKDIR/slurm/neo4j_sidecar.sh not deployed (rsync the repo to \$WORKDIR)."
    exit 1
fi
source "$WORKDIR/slurm/neo4j_sidecar.sh"
neo4j_start || exit 1

# ── Stream the import through LightRAG's own storage classes ─────────────────
STORAGE_DIR="$STORAGE_DIR" \
NODE_BATCH=${NODE_BATCH:-2000} \
EDGE_BATCH=${EDGE_BATCH:-1000} \
  PYTHONPATH="$WORKDIR" python "$WORKDIR/scripts/migrate_to_db_backends.py" --ingest-graph
EXIT_CODE=$?

neo4j_stop

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date)] MIGRATION OK — .graph_backend stamped. Next ingest cycle:"
    echo "    sbatch --export=ALL,GRAPH_BACKEND=neo4j job_westbury_ingest_v2_<cluster>.slurm"
else
    echo "[$(date)] MIGRATION FAILED (exit $EXIT_CODE) — marker NOT stamped; ingest stays on NetworkXStorage. Re-run is safe (idempotent MERGE)."
fi
exit $EXIT_CODE
