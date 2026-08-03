#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=atlas_kg
#SBATCH --output=/scratch/devon7y/westbury_rag/atlas/logs/%x_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/atlas/logs/%x_%j.err
#SBATCH --time=04:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=96G

# Reduce the 6.4 GB knowledge graph to the few hundred best-connected entities the
# Atlas actually draws. Streamed in place — the graphml never leaves the cluster.
set -euo pipefail
WORKDIR=/scratch/devon7y/westbury_rag
"$WORKDIR/venv/bin/python" "$WORKDIR/atlas/pc_export_kg.py" \
    --graphml "$WORKDIR/rag_storage_full/graph_chunk_entity_relation.graphml" \
    --out "$WORKDIR/atlas/out"
echo "[$(date)] done"
