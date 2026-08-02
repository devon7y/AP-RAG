r"""
export_neo4j_graphml.py — dump a LightRAG Neo4j graph store back to GraphML.

Why (Fix-graph, docs/INGEST_SCALING_BOTTLENECK.md): once ingest runs with
GRAPH_STORAGE=Neo4JStorage, graph_chunk_entity_relation.graphml stops updating —
it becomes a frozen snapshot. Two consumers still need a *current* GraphML file:

  1. reembed mode (pipeline/ingest.py REBUILD_EMBEDDINGS=1) reads entity/relation
     data via nx.read_graphml; its freshness guard refuses a snapshot older than
     the last Neo4j-backed run and points here.
  2. The portability property (SCALING_ISSUES.md §5 constraint 4): the GraphML is
     the file that Globus-races between clusters and seeds the PC migration. Keep
     it as the portable archive; Neo4j is the working store.

Reads straight from Neo4j with the official driver (no LightRAG import needed) and
streams — memory stays flat regardless of graph size. Output matches what
networkx's write_graphml produces for LightRAG's undirected graph (nodes before
edges, attr.name-keyed <data>, edgedefault="undirected"), so nx.read_graphml and
scripts/migrate_to_db_backends.py's _iter_graphml both round-trip it.

Usage (with the Neo4j sidecar/service up):
    NEO4J_URI=bolt://127.0.0.1:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=... \
    python export_neo4j_graphml.py --out /path/to/graph_chunk_entity_relation.graphml

Env: NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD (required),
     NEO4J_DATABASE (default neo4j), NEO4J_WORKSPACE (default base — LightRAG's
     node label; must match the ingest run's workspace), STORAGE_DIR (used for
     the default --out path when set).

The write is atomic (tmp file + rename): consumers never see a half-written file,
and the fresh mtime is what un-blocks the reembed freshness guard.
"""

import argparse
import os
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from neo4j import GraphDatabase

PROGRESS_EVERY = 200_000


def _gml_type(value) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "long"
    if isinstance(value, float):
        return "double"
    return "string"


def _gml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return escape(str(value))


def _discover_keys(session, label: str) -> tuple[dict, dict]:
    """Map property name -> GraphML attr.type for nodes and edges.

    GraphML requires <key> declarations before the <graph> element, so the key
    set must be known up front. LightRAG's property set is small (~8 names);
    the type is sniffed from one sample value per key.
    """
    node_keys, edge_keys = {}, {}
    for target, query, out in (
        ("node", f"MATCH (n:`{label}`) UNWIND keys(n) AS k RETURN DISTINCT k", node_keys),
        ("edge", f"MATCH (:`{label}`)-[r:DIRECTED]->(:`{label}`) "
                 "UNWIND keys(r) AS k RETURN DISTINCT k", edge_keys),
    ):
        for record in session.run(query):
            out[record["k"]] = "string"
        for k in out:
            if target == "node":
                sample = session.run(
                    f"MATCH (n:`{label}`) WHERE n[$k] IS NOT NULL RETURN n[$k] AS v LIMIT 1",
                    k=k,
                ).single()
            else:
                sample = session.run(
                    f"MATCH (:`{label}`)-[r:DIRECTED]->(:`{label}`) "
                    "WHERE r[$k] IS NOT NULL RETURN r[$k] AS v LIMIT 1",
                    k=k,
                ).single()
            if sample is not None:
                out[k] = _gml_type(sample["v"])
    return node_keys, edge_keys


def export(uri: str, user: str, password: str, database: str, label: str,
           out_path: Path) -> int:
    label = label.replace("`", "``")  # backtick-quoted identifier, same as neo4j_impl
    driver = GraphDatabase.driver(uri, auth=(user, password))
    tmp_path = out_path.with_suffix(out_path.suffix + ".export_tmp")
    t0 = time.time()
    n_nodes = n_edges = 0
    try:
        with driver.session(database=database) as session, \
                tmp_path.open("w", encoding="utf-8") as f:
            node_keys, edge_keys = _discover_keys(session, label)
            print(f"[export] node keys: {node_keys}", flush=True)
            print(f"[export] edge keys: {edge_keys}", flush=True)

            f.write('<?xml version="1.0" encoding="utf-8"?>\n')
            f.write(
                '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
                'xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns '
                'http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">\n'
            )
            key_ids: dict[tuple[str, str], str] = {}
            for i, (domain, keys) in enumerate((("node", node_keys), ("edge", edge_keys))):
                for j, (name, typ) in enumerate(sorted(keys.items())):
                    kid = f"d{i}_{j}"
                    key_ids[(domain, name)] = kid
                    f.write(
                        f'  <key id="{kid}" for="{domain}" attr.name={quoteattr(name)} '
                        f'attr.type="{typ}" />\n'
                    )
            f.write('  <graph edgedefault="undirected">\n')

            for record in session.run(
                f"MATCH (n:`{label}`) RETURN n.entity_id AS id, properties(n) AS p"
            ):
                node_id, props = record["id"], record["p"]
                if node_id is None:
                    continue
                f.write(f"    <node id={quoteattr(str(node_id))}>\n")
                for k, v in props.items():
                    if v is None or (("node", k) not in key_ids):
                        continue
                    f.write(
                        f'      <data key="{key_ids[("node", k)]}">{_gml_value(v)}</data>\n'
                    )
                f.write("    </node>\n")
                n_nodes += 1
                if n_nodes % PROGRESS_EVERY == 0:
                    print(f"[export] {n_nodes} nodes "
                          f"({n_nodes / max(time.time() - t0, 1e-9):.0f}/s)", flush=True)
            print(f"[export] nodes DONE: {n_nodes} in {time.time() - t0:.0f}s", flush=True)

            t1 = time.time()
            for record in session.run(
                f"MATCH (a:`{label}`)-[r:DIRECTED]->(b:`{label}`) "
                "RETURN a.entity_id AS s, b.entity_id AS t, properties(r) AS p"
            ):
                s, t, props = record["s"], record["t"], record["p"]
                if s is None or t is None:
                    continue
                f.write(f"    <edge source={quoteattr(str(s))} target={quoteattr(str(t))}>\n")
                for k, v in props.items():
                    if v is None or (("edge", k) not in key_ids):
                        continue
                    f.write(
                        f'      <data key="{key_ids[("edge", k)]}">{_gml_value(v)}</data>\n'
                    )
                f.write("    </edge>\n")
                n_edges += 1
                if n_edges % PROGRESS_EVERY == 0:
                    print(f"[export] {n_edges} edges "
                          f"({n_edges / max(time.time() - t1, 1e-9):.0f}/s)", flush=True)
            print(f"[export] edges DONE: {n_edges} in {time.time() - t1:.0f}s", flush=True)

            f.write("  </graph>\n</graphml>\n")
        os.replace(tmp_path, out_path)
    finally:
        tmp_path.unlink(missing_ok=True)
        driver.close()
    size_gb = out_path.stat().st_size / 1e9
    print(f"[export] WROTE {out_path} ({size_gb:.2f} GB, {n_nodes} nodes, "
          f"{n_edges} edges, {time.time() - t0:.0f}s total)", flush=True)
    return 0


def main() -> int:
    storage_dir = os.environ.get("STORAGE_DIR", "")
    default_out = (
        str(Path(storage_dir) / "graph_chunk_entity_relation.graphml")
        if storage_dir else None
    )
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--out", default=default_out, required=default_out is None,
                    help="destination .graphml (default: $STORAGE_DIR/graph_chunk_entity_relation.graphml)")
    ap.add_argument("--workspace", default=os.environ.get("NEO4J_WORKSPACE", "").strip() or "base",
                    help="LightRAG workspace = Neo4j node label (default: base)")
    ap.add_argument("--database", default=os.environ.get("NEO4J_DATABASE", "neo4j"))
    args = ap.parse_args()

    uri = os.environ.get("NEO4J_URI", "")
    user = os.environ.get("NEO4J_USERNAME", "")
    password = os.environ.get("NEO4J_PASSWORD", "")
    if not (uri and user and password):
        print("ERROR: NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD must be set")
        return 1
    return export(uri, user, password, args.database, args.workspace, Path(args.out))


if __name__ == "__main__":
    sys.exit(main())
