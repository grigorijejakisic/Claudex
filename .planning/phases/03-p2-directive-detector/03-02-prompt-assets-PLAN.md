---
plan_id: 03-02
phase: 3
wave: 1
depends_on: []
files_modified:
  - src/intelligence/directive-detector-prompts/confirmation-few-shot.json
  - src/intelligence/directive-detector-prompts/scope-rubric-few-shot.json
  - src/intelligence/directive-detector-prompts/confirmation-system-prompt.md
  - src/intelligence/directive-detector-prompts/scope-rubric-system-prompt.md
  - src/tests/intelligence/directive-detector-prompts.test.ts
autonomous: true
requirements:
  - EXTR-01
  - EXTR-02
---

# Plan 03-02: Prompt Fixture Assets

## Objective

Ship the swappable prompt assets (JSON few-shot + MD system prompts) that Plan 03-01's detector will load via `loadPromptAssets()` — currently stubbed. No code path depends on this plan for compilation, but Plan 03-05's precision harness run CANNOT start until these assets are in place.

## Must-haves (goal-backward)

- `confirmation-few-shot.json` — exactly 9 examples: 3 session-scope, 3 project-scope, 3 universal-scope. Drawn from the user's actual directives (CLAUDE.md global + `memory/feedback_*.md` + sessions 37-51 logs).
- `scope-rubric-few-shot.json` — exactly 9 examples, parallel to the confirmation set but scoped to "given this text is a directive, what's its scope?"
- Each confirmation example has a `context` field with a 3-turn context block (target + 2 flanking), matching the runtime shape.
- `confirmation-system-prompt.md` — static prompt with `{{FEW_SHOT}}` placeholder. Template literal, not executable.
- `scope-rubric-system-prompt.md` — same.
- Test: validates JSON schema + asserts all 9 scope labels are covered 3:3:3.

## Tasks

<task id="03-02-01">
  <subject>Create confirmation-few-shot.json</subject>
  <description>
9 examples, shape:
```json
{
  "examples": [
    {
      "candidate_text": "always use Bun for tests in this project",
      "context": [
        { "role": "user", "turn_offset": -1, "text": "… prior turn …" },
        { "role": "user", "turn_offset":  0, "text": "… the candidate turn, full text …" },
        { "role": "user", "turn_offset": +1, "text": "… next turn …" }
      ],
      "expected_output": {
        "is_directive": true,
        "confidence": 0.95,
        "polarity": "prescriptive",
        "scope": "project",
        "suggested_title": "Use Bun for tests",
        "normalized_text": "Use Bun (not npm or yarn) to run tests in this project.",
        "reasoning": "Explicit standing rule; 'always' + project-specific 'this project'."
      }
    },
    …
  ]
}
```

Seed examples (flesh out exact text during execution by sampling from memory files + session logs):

Session-scope (3):
- "for this PR, keep the refactor minimal"
- "in this debugging session, don't commit until I say"
- "during this review, only flag critical issues"

Project-scope (3):
- "always use Bun for tests in this project"
- "don't touch the legacy llama-server files"
- "we use sqlite-vec, not Qdrant, for vector storage"

Universal (3):
- "be concise — output displays in terminal"
- "use Sonnet for workers, Opus only for product-defining work"
- "never run destructive git commands without asking"

Include at least one NEGATIVE example (is_directive=false) to teach the LLM rejection. E.g., "should we always use Bun here?" (question, not directive) → is_directive=false, confidence=0.90, everything else null. Aim for 2 negative examples in the 9 total — adjust quota to 2 session + 3 project + 2 universal + 2 negative.

Actually: make it 9 positive + 3 negative = 12 examples. Clearer teaching signal. Split:
- 3 session + 3 project + 3 universal = 9 positive
- 3 negative (one in voice of each scope — shows what almost-directives look like)
  </description>
</task>

<task id="03-02-02">
  <subject>Create scope-rubric-few-shot.json</subject>
  <description>
9 examples, shape:
```json
{
  "examples": [
    {
      "text": "always use Bun for tests in this project",
      "expected_scope": "project",
      "rationale": "Contains 'this project' — explicit project-local anchor."
    },
    …
  ]
}
```

Same 3:3:3 split across session/project/universal. No negative examples needed — the confirmation layer has already accepted `is_directive=true` before this rubric runs.

Rationale field is critical — few-shot performance with reasoning traces is substantially better than label-only on small models. Keep each rationale ≤120 chars for prompt compactness.
  </description>
</task>

<task id="03-02-03">
  <subject>Create confirmation-system-prompt.md</subject>
  <description>
File layout:

```markdown
You detect user directives in conversation transcripts from a coding agent.

A directive is a STANDING RULE the user states for future turns — not:
- a task request ("add a button")
- a clarifying question
- an observation or complaint about the past
- a one-off instruction for the current step only

Scope taxonomy:
- **session**: scoped to the current task, PR, debugging loop, or review
- **project**: applies everywhere in the current repo
- **universal**: applies across every project the user works on

Polarity:
- **prescriptive**: do X (positive assertion)
- **prohibitive**: don't do X (negative assertion)

Output JSON only, matching this schema exactly:
{ "is_directive": bool,
  "confidence": number (0..1),
  "polarity": "prescriptive"|"prohibitive"|null,
  "scope": "session"|"project"|"universal"|null,
  "suggested_title": string|null,
  "normalized_text": string|null,
  "reasoning": string }

Reject criteria (is_directive=false):
- Question phrasing ("should we always X?")
- Past-tense observation ("I noticed we always do X")
- Hedged preference ("I kind of prefer X", "I think X is nice")
- Quoted speech from outside the user ("the manual says 'always X'")

When is_directive=false, set polarity/scope/suggested_title/normalized_text to null.

EXAMPLES
---
{{FEW_SHOT}}
---

Now analyze the following candidate. Context is provided as ±2 surrounding user turns. The CANDIDATE turn is marked.
```

Formatter contract: `loadPromptAssets()` reads this file and replaces `{{FEW_SHOT}}` with `JSON.stringify(examples, null, 2)` from the JSON fixture.
  </description>
</task>

<task id="03-02-04">
  <subject>Create scope-rubric-system-prompt.md</subject>
  <description>
Analogous structure to 03-02-03, but for the optional scope-rubric pass. Note: the confirmation prompt ALREADY includes scope decisioning (it's one JSON field), so this second prompt is currently unused by the detector pipeline. Ship it anyway because:
1. CONTEXT §Area 3 commits to "Classification rubric in prompt: few-shot with real examples … lives in a JSON fixture file."
2. If iteration Cycle 2 or 3 (see RESEARCH §1.6) reveals scope is the dominant failure mode, we can split scope into a second LLM call without a new file.

Prompt:
```markdown
You classify the scope of a confirmed user directive.

Scope taxonomy:
- **session**: scoped to a specific task, PR, debugging loop, or review
- **project**: applies everywhere in one repo
- **universal**: applies across every project the user works on

Output JSON only: { "scope": "session"|"project"|"universal", "rationale": string }

Heuristics:
- Language anchors: "this PR", "in this session" → session
- Language anchors: "in this project", "here we", repo-specific filenames → project
- Generic voice, no project anchor, applies across repos → universal
- When ambiguous between project and universal, PREFER project (higher bar for universal).

EXAMPLES
---
{{FEW_SHOT}}
---

Now classify:
```

Exists for future use; not called by the pipeline yet.
  </description>
</task>

<task id="03-02-05">
  <subject>Wire loadPromptAssets() in directive-detector.ts</subject>
  <description>
Replace Plan 03-01's inline prompt stubs (task 03-01-06) with a file-backed loader:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PromptAssets {
  confirmationSystem: string;   // composed: system prompt with {{FEW_SHOT}} filled
  dedupRelationSystem: string;  // same
  scopeRubricSystem: string;    // same (reserved; not called by default pipeline)
}

let _cached: PromptAssets | null = null;

export function loadPromptAssets(reload = false): PromptAssets {
  if (_cached && !reload && !process.env['DIRECTIVE_DETECTOR_RELOAD_PROMPTS']) return _cached;
  const dir = path.resolve(__dirname, 'directive-detector-prompts');
  const cSys = fs.readFileSync(path.join(dir, 'confirmation-system-prompt.md'), 'utf8');
  const cFew = JSON.parse(fs.readFileSync(path.join(dir, 'confirmation-few-shot.json'), 'utf8'));
  const sSys = fs.readFileSync(path.join(dir, 'scope-rubric-system-prompt.md'), 'utf8');
  const sFew = JSON.parse(fs.readFileSync(path.join(dir, 'scope-rubric-few-shot.json'), 'utf8'));
  _cached = {
    confirmationSystem: cSys.replace('{{FEW_SHOT}}', JSON.stringify(cFew.examples, null, 2)),
    dedupRelationSystem: DEDUP_RELATION_SYSTEM_PROMPT_INLINE,  // stays inline — no fixture needed per CONTEXT
    scopeRubricSystem:   sSys.replace('{{FEW_SHOT}}', JSON.stringify(sFew.examples, null, 2)),
  };
  return _cached;
}
```

Note: `__dirname` behavior under `esbuild` bundling — confirm via `bun run build` that the dist bundle still resolves the prompt dir. If bundling breaks the path: use `new URL('./directive-detector-prompts/...', import.meta.url)` for ESM, or commit that we ship the prompts dir alongside `dist/` (prefer path resolution that works post-bundle).

Called once by `extractDirectivesFromSession` before any candidate processing. Non-cached path is testable via `reload=true`.
  </description>
</task>

<task id="03-02-06">
  <subject>Write prompt-asset tests — directive-detector-prompts.test.ts</subject>
  <description>
- Asserts both JSON files parse.
- Asserts `confirmation-few-shot.json` has exactly 12 examples (9 positive + 3 negative).
- Asserts positive examples are split 3:3:3 across session/project/universal.
- Asserts each example has a valid `expected_output` matching the `ConfirmationResult` shape from 03-01.
- Asserts `scope-rubric-few-shot.json` has exactly 9 examples, 3:3:3 split.
- Asserts both `.md` prompt files contain the `{{FEW_SHOT}}` placeholder exactly once.
- Asserts `loadPromptAssets()` returns a `confirmationSystem` string with no remaining `{{FEW_SHOT}}` placeholder.
- Asserts `loadPromptAssets()` is cached (same reference on second call unless `reload=true`).
  </description>
</task>

## Verification

- `bun run build` succeeds; `dist/` bundle can still resolve the prompt dir (test this by running the precision harness after 03-05 — but the build check proves the compile path works).
- `bun run test src/tests/intelligence/directive-detector-prompts.test.ts` — all pass.
- `rg -n '{{FEW_SHOT}}' src/intelligence/directive-detector-prompts/` — returns exactly 2 hits (one per MD file).
- File byte counts reasonable: few-shot JSONs ≤ 16KB each, MD prompts ≤ 4KB each.
