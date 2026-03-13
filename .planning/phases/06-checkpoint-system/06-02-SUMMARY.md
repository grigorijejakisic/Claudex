# 06-02 Summary: Checkpoint Loader and Inject Renderer

**Status:** Complete
**Duration:** ~3min
**Files:** 4 (2 source, 2 test)

## What was built

- `src/checkpoint/loader.ts` — Two-layer recovery: DB-first (re-mirror committed, discard pending) + file fallback (latest.yaml ref, dir scan by mtime, 3-hop chain with cycle detection). Selective loading presets (ALWAYS/RESUME/GSD).
- `src/checkpoint/inject.ts` — Checkpoint-to-markdown renderer producing assembly-ready sections: working, thread, decisions, files, open_items, learnings, gsd. Respects presets. Omits empty sections.

## Key decisions

- recoverFromDb: committed rows re-mirrored, pending rows deleted
- loadFromFile: latest.yaml -> dir scan sorted by mtime desc -> null
- followHopChain: Set<string> for cycle detection, max 3 hops
- applyPreset: ALWAYS = meta+working+topic, RESUME = all except gsd, GSD = full
- inject renderer: sections in priority order, markdown headers, numbered decisions, bulleted lists

## Tests: 37 passing

- 4 recoverFromDb tests (re-mirror, delete pending, empty, invalid data)
- 6 loadFromFile tests (latest.yaml, dir scan, mtime, empty, nonexistent, bad YAML)
- 4 followHopChain tests (3-hop, null previous, cycle, nonexistent)
- 9 loadCheckpoint tests (DB mirrored, committed re-mirror, file fallback, both fail)
- 14 inject renderer tests (all sections, presets, empty, malformed)
