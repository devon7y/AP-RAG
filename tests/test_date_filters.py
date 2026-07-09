"""Precision-aware date-window filtering (aprag_search).

Pure-function tests — no LightRAG/Qdrant/OpenAI needed, like the chunker tests.
Run: python -m pytest tests/test_date_filters.py -v
"""
import os
import sys

import pytest

# aprag_search imports apa_citations; both live at the repo root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

aprag_search = pytest.importorskip("aprag_search")
rm = aprag_search.record_matches


def rec(date=None, year=None):
    r = {}
    if date is not None:
        r["date"] = date
    if year is not None:
        r["year"] = year
    return r


# ── interval endpoints ────────────────────────────────────────────────────────
def test_endpoint_expansion():
    assert aprag_search._date_endpoint("2026", False) == (2026, 1, 1)
    assert aprag_search._date_endpoint("2026", True) == (2026, 12, 31)
    assert aprag_search._date_endpoint("2026-03", False) == (2026, 3, 1)
    assert aprag_search._date_endpoint("2026-03", True) == (2026, 3, 31)
    assert aprag_search._date_endpoint("2026-03-17", False) == (2026, 3, 17)
    assert aprag_search._date_endpoint("2026-03-17", True) == (2026, 3, 17)
    assert aprag_search._date_endpoint("garbage", False) is None


# ── day-precise record in a month window ──────────────────────────────────────
def test_day_record_in_window():
    r = rec(date="2026-03-17")
    assert rm(r, {"date_from": "2026-01", "date_to": "2026-06"})
    assert rm(r, {"date_from": "2026-03-17", "date_to": "2026-03-17"})  # exact day
    assert not rm(r, {"date_from": "2026-04", "date_to": "2026-06"})    # after window
    assert not rm(r, {"date_from": "2026-01", "date_to": "2026-02"})    # before window


# ── open-ended windows ────────────────────────────────────────────────────────
def test_open_ended():
    r = rec(date="2026-03-17")
    assert rm(r, {"date_from": "2026-01"})            # from only
    assert not rm(r, {"date_from": "2026-04"})
    assert rm(r, {"date_to": "2026-12"})              # to only
    assert not rm(r, {"date_to": "2026-02"})


# ── the key case: a year-only record still appears in a month window in its year ─
def test_year_only_record_matches_month_window():
    r = rec(date="2020")                              # whole-year interval
    assert rm(r, {"date_from": "2020-03", "date_to": "2020-06"})
    assert rm(r, {"date_from": "2020-11", "date_to": "2021-02"})  # straddles year end
    assert not rm(r, {"date_from": "2021-01", "date_to": "2021-06"})  # wrong year


def test_year_fallback_when_no_date_field():
    r = rec(year="2019")                              # no `date`, only `year`
    assert rm(r, {"date_from": "2019-05", "date_to": "2019-08"})
    assert not rm(r, {"date_from": "2020-01", "date_to": "2020-12"})


# ── month-precise record straddling nothing ───────────────────────────────────
def test_month_record():
    r = rec(date="2026-03")                           # [2026-03-01, 2026-03-31]
    assert rm(r, {"date_from": "2026-03-15", "date_to": "2026-03-20"})  # overlaps mid-month
    assert rm(r, {"date_from": "2026-03", "date_to": "2026-03"})
    assert not rm(r, {"date_from": "2026-04-01", "date_to": "2026-04-30"})


# ── a record with no date at all cannot satisfy a date window ──────────────────
def test_no_date_excluded():
    assert not rm({}, {"date_from": "2020-01", "date_to": "2020-12"})


# ── date window ANDs with other dimensions ────────────────────────────────────
def test_date_window_ands_with_author():
    r = {"date": "2026-03-10", "authors": [{"family": "Westbury", "given": "C"}]}
    assert rm(r, {"date_from": "2026-01", "date_to": "2026-06", "authors": ["westbury"]})
    assert not rm(r, {"date_from": "2026-01", "date_to": "2026-06", "authors": ["nairne"]})
    assert not rm(r, {"date_from": "2025-01", "date_to": "2025-12", "authors": ["westbury"]})


# ── no date filter present -> date logic is a no-op ───────────────────────────
def test_no_date_filter_is_noop():
    assert rm(rec(date="2000-01-01"), {"authors": []}) is True
    assert aprag_search.has_filters({"date_from": "2026-01"}) is True
    assert aprag_search.has_filters({}) is False
