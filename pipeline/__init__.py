"""
pipeline — AP-RAG academic-paper ingestion pipeline.

Structure-aware chunkers (scientific papers and books), Anthropic-style chunk
contextualization, and the LightRAG ingest entry point. These are injected into the
stock LightRAG engine (e.g. as `chunking_func=`); LightRAG itself stays patch-free.
"""
