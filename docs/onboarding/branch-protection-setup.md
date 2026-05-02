# Branch Protection Setup — Vesna CI Required

This runbook describes how to apply the branch protection rule that gates merges to `master` on the public repo `grigorijejakisic/Claudex` behind a passing Vesna CI run. It is HITL — the GitHub UI is the only practical path to apply this rule (gh CLI's API support is for "rulesets," a different mechanism with separate semantics).

## Why this exists

Phase 10 shipped Vesna CI as the behavioral gate for v4 ships (17 probes, 100% PASS aggregate, 100% per non-empty category). It runs on every push to `master` via `.github/workflows/vesna.yml`. Branch protection makes that gate enforced — strangers (or the maintainer in a tired moment) cannot merge a PR that breaks behavioral parity.

It is HITL because:

- The simplest path is the GitHub UI's "classic" branch protection settings — five clicks, two minutes.
- gh CLI's branch protection support targets "rulesets" (the newer mechanism); we want the classic rule (matches Phase 10's pre-set expectation and the Vesna workflow's existing trigger semantics).
- The rule MUST be applied by an account with admin rights on `grigorijejakisic/Claudex` — that is the operator (`grigorijejakisic`), not Corleanus (the working dev account that lacks admin on the public repo by design).

## Click path

1. **Navigate** to `https://github.com/grigorijejakisic/Claudex/settings/branches`. Sign in as `grigorijejakisic` if not already.
2. **Click** "Add rule" (under "Branch protection rules"). If a rule for `master` already exists, click "Edit" instead.
3. **Branch name pattern:** type `master` exactly.
4. **Check** "Require a pull request before merging" (optional but recommended; Phase 11 SC#4 cold-start trial pattern).
5. **Check** "Require status checks to pass before merging."
6. **Check** "Require branches to be up to date before merging" (this is the strict mode that prevents merge-skew bugs).
7. **In the search box** under "Status checks that are required," type `Vesna`. Select the matching check from the dropdown — typically `Vesna / probes` or just `Vesna` depending on how the workflow's `name:` field was set in `.github/workflows/vesna.yml`.

   **Note:** the Vesna check will only appear in the dropdown AFTER the Vesna workflow has run at least once on the public repo. The workflow runs on every push to `master`, so the first push from Plan 17-02 should trigger it — wait for that run to complete before opening this settings page, or the search will return no matches.

8. **Leave** "Do not allow bypassing the above settings" UNchecked. This lets the operator (admin) override in emergencies (cold-fix the live repo without spinning up a new branch). Strangers without admin still cannot bypass.
9. **Click** "Create" (or "Save changes" if editing).

The rule is now active. Subsequent pushes to `master` that are not via PR, or PRs whose Vesna check fails, will be rejected by GitHub.

## Verification

```bash
gh api repos/grigorijejakisic/Claudex/branches/master/protection \
  --jq '.required_status_checks.contexts'
# Expected: ["Vesna"] (or whatever the workflow's name resolves to)
```

If this returns `null` or empty, the rule didn't apply — re-walk the click path. If it returns `404 Not Found`, branch protection is not active on `master`.

## Maintenance

If the Vesna workflow's `name:` changes (in `.github/workflows/vesna.yml`), the branch protection rule must be updated to match — the rule references the check by name, not by path. Re-walk steps 1, 2 (Edit), 7 (search for the new name), 9 (Save changes).

If a future v4.2+ ships additional CI gates (e.g., LongMemEval baseline, doctor self-check), each new check must be added to the "required status checks" list via the same click path.

## Operator fallback — release + topics if gh CLI as Corleanus lacked permission

The autonomous Phase 17 run logged that `gh release create` and `gh repo edit --add-topic` both failed for `grigorijejakisic/Claudex`. The gh CLI is authenticated as `Corleanus` (working dev account); Corleanus has read access to the public repo but lacks write permission. The operator must run these as `grigorijejakisic`.

Errors observed during autonomous run:

- `gh release create v4.1.0 --repo grigorijejakisic/Claudex ...` → `Failed to create release, "workflow" scope may be required.` (Corleanus already has `workflow` scope; the error is misleading — root cause is missing write permission on the repo.)
- `gh repo edit grigorijejakisic/Claudex --add-topic ...` → `HTTP 404: Not Found (https://api.github.com/repos/grigorijejakisic/Claudex/topics)` (404 from this endpoint with read-only auth is GitHub's permission-mask behaviour; root cause is the same.)

### One-time auth as grigorijejakisic

```bash
gh auth login --hostname github.com --user grigorijejakisic
# Follow the device-flow prompts; complete in the browser
gh auth status
# Expect: Logged in to github.com account grigorijejakisic
```

### Re-run release creation

The release notes file from the autonomous run is preserved at `/tmp/phase17-fallback/release-notes.md`. If lost, re-extract:

```bash
awk '
  /^## \[4.1.0\] — 2026-05-02/ { flag=1; next }
  /^## \[/ && flag { exit }
  flag { print }
' CHANGELOG.md > /tmp/phase17-fallback/release-notes.md

gh release create v4.1.0 \
  --repo grigorijejakisic/Claudex \
  --title "v4.1.0 — Distribution" \
  --notes-file /tmp/phase17-fallback/release-notes.md \
  --verify-tag
```

### Re-run topic application

```bash
gh repo edit grigorijejakisic/Claudex \
  --add-topic claude-code \
  --add-topic mcp \
  --add-topic agent-memory \
  --add-topic llm-tools \
  --add-topic typescript \
  --add-topic bun \
  --add-topic claudex \
  --add-topic persistent-memory \
  --add-topic claude
```

### Verify

```bash
gh release view v4.1.0 --repo grigorijejakisic/Claudex --json url,name | head -3
gh repo view grigorijejakisic/Claudex --json repositoryTopics --jq '.repositoryTopics | length'
# Expected: 9
```

### Switch back to Corleanus (optional)

```bash
gh auth switch --hostname github.com --user Corleanus
```

The grigorijejakisic auth remains stored under gh's credential store; switching is reversible.
