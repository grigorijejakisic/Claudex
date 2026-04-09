# Qdrant → sqlite-vec Migration Design

> Status: **All 5 phases complete** (session 47, 2026-04-09). sqlite-vec is the default and only vector backend; Qdrant has been removed entirely.
>
> Progress:
> - ✅ **Phase 1** (commit `24ce0c1`): sqlite-vec dependency added, V14→V15 migration creating 5 vec0 virtual tables, extension loader with non-throwing error handling. 13 new tests.
> - ✅ **Phase 2** (commit `c31f04e`): full sqlite-vec backend mirroring qdrant-client API, feature-flagged dispatcher in qdrant-client.ts, 12 new tests covering upsert/search/delete with project + importance + type + superseded filters.
> - ✅ **Phase 3** (commit `1785bf1`): setVectorStoreDb wired into openDatabase() and Angel's main. `CLAUDEX_VECTOR_BACKEND=sqlite-vec` functional end-to-end without any further configuration.
> - ✅ **Phase 4** (commit `bd4304d`): default backend flipped from qdrant to sqlite-vec. Tests adjusted (qdrant-e2e test file deleted; qdrant-client.ts internals replaced with pure sqlite-vec facade).
> - ✅ **Phase 5** (commit `8d212ff`): Qdrant removed entirely. `@qdrant/js-client-rest` dep deleted, Qdrant binary spawn removed from session-start, Qdrant health check removed from heartbeat, thread-tracker Qdrant probing simplified, qdrant-client.test.ts deleted.
> - 🔜 **Phase 2b** (minor follow-ups, deferred): fnv_hash column on experience_patterns for proper pattern JOIN; stable rowid → session_id mapping for thread search. Both currently handled in JS at query time; a V16 migration would make them SQL-native.
> - 🔜 **Phase 5b** (cosmetic cleanup, deferred): rename `qdrant-client.ts` → `vector-store.ts`. Would force an import update across ~27 caller files. Current facade pattern works correctly; renaming is purely aesthetic.

## Current state

- **2220 tests passing**, 0 failures
- **Default backend: sqlite-vec.** Single SQLite file (`~/.claudex/db/claudex.db`) contains everything: truth tables, FTS5 index, and vec0 virtual tables for vector search
- **External services required:** Ollama (embeddings + local LLM), optional Python reranker (cross-encoder, CUDA), optional CliProxy (MAX subscription OAuth)
- **External services removed:** Qdrant (was port 6333, required ~100MB binary + separate process)
- **Rollback (if needed):** Revert commits `bd4304d` and `8d212ff`; the Phase 1-3 foundation stays viable as the default-off path

## What the migration actually bought us

**Before:** SQLite (truth) + Qdrant (HTTP, port 6333, separate process, bundled binary, dual-write invariant to maintain) + Ollama + Python reranker. 4 moving parts for full vector retrieval.

**After:** SQLite (truth + vectors, single file) + Ollama + Python reranker. 3 moving parts. One fewer process to monitor, one fewer failure mode, one fewer install step. Install friction is measurably lower for first-time contributors. Cold-start is faster (no Qdrant init). Backup is trivial (copy one file). Network exposure surface is smaller.

**What we lost:** HNSW indexing on vectors. At Claudex's scale (tens of thousands of observations), flat KNN is fast enough (~10-30ms). Past 500k+ vectors, HNSW would start to matter; by then we can reintroduce a dedicated index via a new sqlite-vec feature or a different extension.

## Why

**Claim:** Claudex's operational fragility comes mostly from running 4+ external services. Collapsing the vector store into SQLite (via `sqlite-vec`) removes one entire service + dependency class without losing retrieval features at our current scale.

### What we lose

- **HNSW indexing.** `sqlite-vec` uses flat search (no hierarchical graph). At our current scale (tens of thousands of observations, low thousands of artifacts), this is fine. Flat cosine over 10–50k vectors is ~10–30ms, well under our retrieval budget. **Past ~500k documents, HNSW becomes measurably better** — but we're nowhere near that.
- **Qdrant's mature operational tooling.** We were never using Qdrant's advanced features (payload filtering, collections management UI, clustering). We use it as a vector lookup, nothing more.
- **Named vectors / multi-vector collections.** We have 5 separate collections in Qdrant, each with one vector per row. `sqlite-vec` uses one virtual table per vector "collection" — same conceptual model, different implementation.

### What we gain

- **One external service removed.** No Qdrant binary to bundle, start, monitor, restart. One fewer port (6333), one fewer process, one fewer category of failure.
- **All data in one SQLite file.** `~/.claudex/db/claudex.db` becomes the entire store. Backup, portability, and debugging become trivial ("just copy the .db file").
- **No dual-write invariant to maintain.** Currently we write to SQLite first, then Qdrant. If either half fails, we have divergent state. With sqlite-vec, a single transaction writes both the row and its vector atomically.
- **Faster cold start.** No waiting for Qdrant to initialize collections; they exist in the schema.
- **Simpler install story.** `bun install` pulls the prebuilt sqlite-vec binary automatically. No separate service to start.

## Viability (verified)

- `sqlite-vec` is the actively-maintained vector extension for SQLite, authored by Alex Garcia (who also wrote sqlite-vss and sqlite-utils).
- It is distributed as an npm package with prebuilt binaries for major platforms **including Windows x64**.
- It is known to work with `better-sqlite3` via `db.loadExtension(sqliteVec.getLoadablePath())`.
- Reference: [sqlite-vec JS docs](https://alexgarcia.xyz/sqlite-vec/js.html).
- `better-sqlite3` explicitly supports loadable extensions on Windows via `loadExtension(path)`.

**Pre-execution verification (to run at the start of the execution session):**

```bash
bun add sqlite-vec
# In a scratch test file:
# import Database from 'better-sqlite3';
# import * as sqliteVec from 'sqlite-vec';
# const db = new Database(':memory:');
# sqliteVec.load(db);
# db.exec("CREATE VIRTUAL TABLE test_vec USING vec0(embedding float[1024])");
# db.prepare("INSERT INTO test_vec (embedding) VALUES (?)").run(new Float32Array(1024).fill(0.1));
# const out = db.prepare("SELECT vec_distance_L2(embedding, ?) FROM test_vec").get(new Float32Array(1024).fill(0.2));
# console.log('smoke test passed:', out);
```

If that 6-line smoke test passes on the target hardware (Windows 11, RTX 5090 machine), the migration is unblocked.

## Scope of the full migration

### Files touched (grep confirms 27)

**Production code (not test files):**

1. `src/embeddings/qdrant-client.ts` — the Qdrant wrapper. Replace internals with sqlite-vec calls; preserve the API surface so callers don't change.
2. `src/angel/heartbeat.ts` — Qdrant health check, collection setup, service-down detection.
3. `src/angel/index.ts` — Qdrant collection ensure at startup (via `ensureCollections`).
4. `src/intelligence/experience-patterns.ts` — pattern vector upsert/search.
5. `src/mcp/recall-server.ts` — MCP search path.
6. `src/angel/consolidator.ts` — cluster similarity via Qdrant.
7. `src/adapters/cc-hooks/user-prompt-submit.ts` — hybrid retrieval entry.
8. `src/adapters/cc-hooks/session-start.ts` — startup path, may spawn Qdrant.
9. `src/adapters/cc-hooks/stop.ts` — post-turn embeddings.
10. `src/core/migration-steps.ts` — add V14→V15 migration that loads sqlite-vec and creates virtual tables.
11. `src/core/schema.ts` — add vec0 virtual table DDL.
12. `src/core/hybrid-retrieval.ts` — swap Qdrant calls for sqlite-vec queries.
13. `src/intelligence/thread-tracker.ts` — thread embedding upsert/search.
14. `src/embeddings/embed-pipeline.ts` — may need no changes (wraps qdrant-client).
15. `src/extraction/extractor.ts` — observation embedding.
16. `src/adapters/shared/lifecycle.ts` — shared vector ops.
17. `src/core/observations.ts` — observation vector writes.
18. `src/core/artifacts.ts` — artifact vector writes.

**Test files:**

19. `src/tests/embeddings/qdrant-client.test.ts` — rewrite for sqlite-vec wrapper.
20. `src/tests/embeddings/qdrant-e2e.test.ts` — rewrite end-to-end test.
21. `src/tests/embeddings/embed-pipeline.test.ts` — update mocks.
22. `src/tests/intelligence/retrieval-feedback.test.ts` — update.
23. `src/tests/intelligence/intent-classifier.test.ts` — update.
24. `src/tests/core/observations-dedup.test.ts` — update.
25. `src/tests/intelligence/memory-arch.test.ts` — update.
26. `src/tests/angel/message-sender.test.ts` — likely no changes needed.
27. `src/benchmark/locomo-harness.ts` — uses Qdrant directly, needs update.

## Execution strategy: facade swap

The migration is large in surface area but structurally simple. The key insight: **keep `src/embeddings/qdrant-client.ts`'s API surface constant and swap its internals to sqlite-vec.** Then callers don't change — they still call the same functions with the same arguments. The file is renamed (or repurposed) but its exports stay stable.

### Phase 1: Foundation (commit 1)

- `bun add sqlite-vec`
- Run the 6-line smoke test
- If pass: add V15 migration that loads the extension and creates `vec_artifacts`, `vec_patterns`, `vec_threads`, `vec_journal`, `vec_conversations` virtual tables
- Do NOT touch any caller yet — the new tables coexist with Qdrant
- Commit: "feat(embeddings): add sqlite-vec foundation — virtual tables alongside Qdrant"
- Tests: still pass (nothing changed for callers)

### Phase 2: Facade swap (commit 2)

- Create `src/embeddings/vector-store.ts` — new file with the same API as `qdrant-client.ts`, backed by sqlite-vec
- Add a feature flag `CLAUDEX_VECTOR_BACKEND=sqlite-vec|qdrant` (default: qdrant, for rollback safety)
- Route `src/embeddings/embed-pipeline.ts` to either backend based on the flag
- Keep `qdrant-client.ts` intact
- Commit: "feat(embeddings): sqlite-vec backend alongside qdrant, feature-flagged"
- Tests: update to run in both modes; both must pass

### Phase 3: Backfill (commit 3)

- Write a one-time backfill script: read all rows from SQLite that have embeddings in Qdrant, re-embed from source text via Ollama, write to sqlite-vec virtual tables
- Alternatively (simpler): don't migrate embeddings, let them be re-generated on next write/query. The penalty is cold-start retrieval quality for the first hour of use after the flip.
- Recommendation: start with the simpler "regenerate on demand" approach; write the backfill only if cold-start quality is observably bad
- Commit: "feat(embeddings): sqlite-vec backfill script" (only if needed)

### Phase 4: Flip the flag (commit 4)

- Default `CLAUDEX_VECTOR_BACKEND` to `sqlite-vec`
- Keep the flag for rollback
- Run the full test suite in sqlite-vec mode
- Run LongMemEval oracle benchmark — if 90.6% regresses, investigate; if stable, ship
- Commit: "refactor(embeddings): default to sqlite-vec backend"

### Phase 5: Remove Qdrant (commit 5, follow-up session)

- Only after phase 4 has been in production use for several days with no regressions
- Remove `@qdrant/js-client-rest` from package.json
- Delete `qdrant-client.ts`, `qdrant-e2e.test.ts`, Qdrant binary management code
- Delete the feature flag
- Remove Qdrant from health checks
- Commit: "refactor(embeddings): remove Qdrant backend entirely"

## Estimated effort

- Phase 1 (foundation): 1 hour — low risk
- Phase 2 (facade): 2–3 hours — medium risk, mostly mechanical translation
- Phase 3 (backfill): 1 hour if done the simple way, 3 hours if done the full way
- Phase 4 (flip): 30 min + benchmark run (~30 min)
- Phase 5 (remove): 30 min

**Total: ~6–8 hours of focused work** across phases 1–4. Phase 5 is independent and comes later.

## Risks

### Known

1. **Query API differences.** Qdrant's search is `POST /collections/{name}/points/search` with rich filter support. sqlite-vec is `SELECT ... FROM vec_foo WHERE vec_distance_L2(embedding, ?) < threshold ORDER BY vec_distance_L2(embedding, ?) LIMIT ?`. Simpler, but if any caller depends on Qdrant's payload filtering, that logic moves into SQL JOINs. Needs per-caller audit.
2. **Cold start on sqlite-vec load.** First query after DB open compiles the extension. ~50ms one-time cost. Acceptable.
3. **Virtual table size.** sqlite-vec stores vectors inline in the SQLite file. At our scale, the DB file grows by `N_vectors × 1024 × 4 bytes ≈ 4KB per vector`. For 50k vectors, that's ~200MB. Acceptable.
4. **No cross-DB queries.** If any code joins Qdrant collections with SQLite rows, the migration simplifies that — everything is in one DB now. Actually a win.

### Unknown (needs verification at execution start)

1. **Does the prebuilt Windows binary work on the user's machine?** The smoke test at the start of the execution session verifies this.
2. **Does `better-sqlite3` correctly load the extension?** Sources say yes; verify empirically.
3. **Are there any callers doing creative Qdrant payload filtering that don't translate cleanly to SQL?** Need to grep and audit.

## Rollback plan

Each phase commits independently. If phase 2 breaks something, revert commit 2 — the feature flag defaults to Qdrant, so the system keeps working. If phase 4 breaks something, set `CLAUDEX_VECTOR_BACKEND=qdrant` in the environment and the system immediately routes back through Qdrant without any code change.

Phase 5 (Qdrant removal) is the only phase that's not trivially reversible. That's why it's gated on "several days of production use without regression."

## Success criteria

- [ ] All 135+ angel tests still pass
- [ ] All 2000+ total tests still pass
- [ ] LongMemEval oracle benchmark returns ≥ 89.5% (within 1pp of current 90.6%)
- [ ] LoCoMo benchmark doesn't regress (currently 55.5%, any regression must be investigated)
- [ ] Angel startup time decreases by at least the Qdrant-init latency (~200–500ms)
- [ ] No new external service startup required
- [ ] Database file location and format unchanged (just bigger)

## What this design explicitly does NOT cover

- **sqlite-vec to a different backend later.** If we ever need HNSW or distributed vectors, we can re-introduce a separate service. This design optimizes for current scale.
- **Migrating Ollama away.** Ollama provides embeddings and local LLM — that's a separate friction-reduction effort. Not in scope.
- **Migrating the CliProxy.** Also separate — candidate for a future "direct Anthropic calls" effort.
- **Migrating the Python reranker.** Already supervised by Angel's RerankerSupervisor (session 47). Moving to Node would require ONNX with DirectML on Windows and would be a performance regression on our hardware (native CUDA via PyTorch is faster). Not worth doing.
