# Agent Note: Knowledge-base BM25 search ranking

Status: implemented

English | [中文](2026-08-15-kb-bm25-search-ranking.zh.md)

## Problem

The knowledge-base keyword search required every query 2-gram to match (strict AND) and returned hits in pinned/date order, so a multi-word query that missed one term returned nothing, results were not ordered by relevance, and a one-character typo silenced matches the 2-gram index could easily tolerate.

## Decision

The engine's inverted index now stores per-document weighted term counts instead of plain document sets, and `kb.search` scores hits with field-weighted BM25 (title 3 / aliases 2.5 / tags 2 / summary 1.5 / body 1). Queries accumulate scores across all postings instead of requiring AND membership, so partial queries return ranked hits, with documents matching more query grams ranking first. A query gram with no exact postings is expanded to its single-character neighbors at a 0.6 weight, tolerating one-character typos in Chinese or Latin without a pinyin table. Result order is score, then pinned, then updated. The `kb.search` wire contract is unchanged; only ranking and recall improve.

## Alternatives considered

### Keep strict AND and only add a relevance tie-break

The cheapest change, but it leaves the recall failure that motivates the work: a query missing one term still returns nothing.

### Query-side synonym dictionary

A hand-maintained global synonym table is a new tunable with no current owner; per-document `aliases` frontmatter already provides the same effect where it matters, and BM25 field weights now reward alias hits. Deferred unless recall evidence demands it.

### Pinyin input tolerance

Requires a full character-to-pinyin table (a new dependency or thousands of lines); the single-character neighbor rule covers typo tolerance without it. Pinyin matching stays a candidate if the agent workflow needs pinyin queries.

### Transformers.js + sqlite-vec semantic search

Phase 3 per the design; introduces model download, inference, vector storage, and threshold tuning for a personal library with no demonstrated recall gap. The `embeddingRef` index field remains reserved for it.

## Consequences

- `total` in `kb.search` now counts all partial matches, not just exact AND hits, so it can exceed the previous total.
- The inverted index now tracks per-document counts; the on-disk `index.json` format is unchanged (it stores summaries, not grams), so existing libraries load without migration.
- Fuzzy neighbor expansion scans the inverted index keys for each missing query gram; fine for a personal library, revisit if the library grows by orders of magnitude.

## Testing

- Engine tests (`packages/host/kb/tests/core.spec.ts`) cover title-above-body ranking, partial multi-term recall, single-character typo tolerance, and alias-above-body ranking, alongside the existing refresh/list tests that still pass under the new scorer.
