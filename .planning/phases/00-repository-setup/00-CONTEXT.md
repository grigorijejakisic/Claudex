# Phase 0: Repository Setup - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Project scaffolding — a buildable, testable TypeScript project with the shared type system and utilities that all subsequent phases depend on. Delivers package.json, tsconfig.json, build.ts, shared types (RuntimeEvent, RuntimeCapabilities, InjectPayload), utility modules (paths, scope-detector, fs-helpers, text-utils, constants, config), and vitest test infrastructure.

</domain>

<decisions>
## Implementation Decisions

### Package Management & Runtime
- Bun 1.3+ as runtime and package manager
- `bun install` for dependency management, bun.lockb lockfile
- `bun test` (vitest) for test runner

### Build Output Targets
- ESM source code (TypeScript strict mode)
- esbuild bundler (build.ts) producing CJS outputs in dist/
- CC hooks require CJS entry points (ephemeral process lifecycle per Section 3.2)
- OpenClaw bridge also CJS with createRequire() pattern (proven for better-sqlite3 on jiti loader)
- Per-module outputs, not single bundle

### Error Handling Patterns
- Defensive non-throwing: every public function catches errors, returns safe defaults
- Utilities return safe defaults (empty string, empty array, null) — not Result<T, E> types
- Prescribed in Architecture Design Principle 10 and Section 15.1

### Config Schema Defaults
- Full config schema with defaults prescribed in Architecture Section 11.1
- Implement as specified — no discretion needed

### Claude's Discretion
- No areas identified requiring Claude's discretion — architecture is fully prescriptive for Phase 0

</decisions>

<specifics>
## Specific Ideas

No specific requirements beyond architecture — Phase 0 is pure infrastructure with clear specs. All file paths, type definitions, utility contracts, and toolchain choices are explicitly defined in ARCHITECTURE.md Sections 13 (project structure) and 14 (implementation plan).

Key references:
- Type system: Architecture Section 3.1 (RuntimeEvent, RuntimeCapabilities, InjectPayload)
- Utility modules: Architecture Section 13 (src/shared/)
- Build tooling: Architecture Section 13 (build.ts → dist/*.mjs)
- Error patterns: Architecture Section 15.1 (defensive non-throwing)
- Cross-platform: Architecture Section 15.5 (atomic writes, Windows EPERM fallback)
- Config schema: Architecture Section 11.1

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 00-repository-setup*
*Context gathered: 2026-03-10*
