"""Unit tests for the INGEST_VLM native-multimodal ingest wiring.

The env is set before importing ``pipeline.ingest`` because that module reads
configuration at import time. We then drive ``ingest_native_multimodal`` with a
fake LightRAG that records the calls, asserting the enqueue/process contract used
by LightRAG's native multimodal pipeline (``docs_format="pending_parse"`` + a
single drain), without needing a real parser service or LLM.
"""

import asyncio
import os

os.environ.setdefault("WORKDIR", "/tmp/aprag_vlm_test")
os.environ["INGEST_VLM"] = "1"
os.environ["PARSE_ENGINE"] = "mineru"
os.environ["PROCESS_OPTIONS"] = "ite"

from pipeline import ingest as ing  # noqa: E402  (import after env is set)


class _FakeRag:
    def __init__(self):
        self.enqueued = []
        self.processed = 0

    async def apipeline_enqueue_documents(self, **kwargs):
        self.enqueued.append(kwargs)
        return "track-id"

    async def apipeline_process_enqueue_documents(self):
        self.processed += 1


def test_native_multimodal_enqueues_each_pdf_then_processes_once(tmp_path):
    pdfs = [tmp_path / f"paper{i}.pdf" for i in range(3)]
    rag = _FakeRag()
    asyncio.run(ing.ingest_native_multimodal(rag, pdfs))

    # One enqueue per PDF, exactly one drain of the queue.
    assert len(rag.enqueued) == 3
    assert rag.processed == 1

    for kw, pdf in zip(rag.enqueued, pdfs):
        assert kw["input"] == ""                       # content comes from the parser
        assert kw["file_paths"] == str(pdf)
        assert kw["docs_format"] == "pending_parse"
        assert kw["parse_engine"] == "mineru"
        assert kw["process_options"] == "ite"
        assert "ids" not in kw                          # never pass ids with pending_parse


def test_enqueue_failure_does_not_abort_batch(tmp_path):
    pdfs = [tmp_path / f"p{i}.pdf" for i in range(3)]

    class _FlakyRag(_FakeRag):
        async def apipeline_enqueue_documents(self, **kwargs):
            if kwargs["file_paths"].endswith("p1.pdf"):
                raise RuntimeError("boom")
            return await super().apipeline_enqueue_documents(**kwargs)

    rag = _FlakyRag()
    asyncio.run(ing.ingest_native_multimodal(rag, pdfs))

    # The bad PDF is skipped; the surviving two still enqueue and the queue drains once.
    assert len(rag.enqueued) == 2
    assert rag.processed == 1
