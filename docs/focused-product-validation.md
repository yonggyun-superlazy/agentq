# Focused Product Validation Plan

AgentQ should stay narrow:

> Prevent independent coding agents from silently stepping on each other in the same workspace.

This document turns that product claim into validation work. It is not a roadmap for a general messaging app, a lock manager, an orchestrator, or a headless resume system.

## Non-Goals

- Do not assign tasks to agents.
- Do not start hidden/headless agent turns.
- Do not lock files or block edits by default.
- Do not build a general chat system.
- Do not add project config before a concrete repeated need exists.
- Do not add actor tombstones until stale behavior is measured and proven insufficient.

## Validation Areas

### 1. Collision Reproduction Demo

Goal: show a real failure mode that normal agent instructions do not reliably prevent.

The demo should make the value visible in under five minutes:

1. Two independent actors enter the same workspace.
2. Actor A declares a path or resource it owns.
3. Actor B is about to touch that same path or resource.
4. `agentq owners` identifies the overlap.
5. Actor B sends a required `question`.
6. Actor B cannot honestly finish until the recipient answers and `done-check` passes.

Recommended demo variants:

| Variant | Collision Surface | Why It Matters |
|---------|-------------------|----------------|
| Path collision | `README.md` or `src/protocol.ts` | Minimal public demo with no external tools. |
| Resource collision | `setup-watcher:ProjectDD/DDSetup` | Shows AgentQ is not a file lock; it coordinates shared tools. |
| Unity collision | `unity:ProjectDD/DDUnity` | Shows soft-exclusive editor/build resources. |

Minimal path demo:

```bash
agentq install --yes

CODEX_ACTOR=$(agentq enter --as codex --session codex-demo --paths src/protocol.ts --responsibility "protocol schema" | sed 's/ registered$//')
CLAUDE_ACTOR=$(agentq enter --as claude-code --session claude-demo --paths src/protocol.ts --responsibility "protocol consumer" | sed 's/ registered$//')

agentq owners --actor "$CLAUDE_ACTOR" --path src/protocol.ts

agentq question \
  --id AQ-demo-path-collision \
  --actor "$CLAUDE_ACTOR" \
  --to "$CODEX_ACTOR" \
  --path src/protocol.ts \
  --question "I need to change src/protocol.ts. Are you actively changing the protocol schema, and what contract must I preserve?" \
  --expect "Answer with active edits or clear-to-edit evidence."

agentq done-check --actor "$CLAUDE_ACTOR"
agentq inbox --actor "$CODEX_ACTOR"
agentq respond AQ-demo-path-collision --actor "$CODEX_ACTOR" --status answered --evidence "No active schema edit; preserve RequiredRequest routing evidence fields."
agentq done-check --actor "$CLAUDE_ACTOR"
```

Expected evidence:

- `owners` prints the other actor.
- `question` routes to the owner.
- sender `done-check` fails while the question is pending.
- receiver `inbox` shows the question body and expected answer.
- receiver `respond` resolves the required request.
- sender `done-check` passes after the answer.

Public artifact:

- Keep the current simulated transcript.
- Keep the before/after transcript in [`../fixtures/demo/before-after/expected.md`](../fixtures/demo/before-after/expected.md). It shows a stale write losing `routingEvidence` before AgentQ, then `owners -> question -> done-check fail/pass` preserving both fields after AgentQ.
- Keep the two-actor collision transcript in [`../fixtures/demo/two-actors/expected.md`](../fixtures/demo/two-actors/expected.md). It does not require Codex, Claude Code, Copilot, Unity, or a project-specific repo.
- Keep the resource coordination transcript in [`../fixtures/demo/resource/expected.md`](../fixtures/demo/resource/expected.md). It uses `setup-watcher:ProjectDD/DDSetup` in a temporary workspace to show that AgentQ coordinates soft-exclusive tools, not only files.

### 2. Resource-First UX

Path ownership is useful, but AgentQ's stronger product wedge is resource coordination.

Detailed resource naming and examples live in [`resources.md`](resources.md).

Resource means "a named shared thing that is not safely represented by one file path." Examples:

| Resource | Meaning |
|----------|---------|
| `setup-watcher:ProjectDD/DDSetup` | DD setup watcher / codegen pipeline is being used. |
| `setup-watcher:ProjectSHE/SHESetup` | SHE setup watcher / codegen pipeline is being used. |
| `codegen:ProjectDD/DDWeaver` | DDWeaver code generation is being run or touched. |
| `unity:ProjectDD/DDUnity` | ProjectDD Unity editor/build/test resource. |
| `unity:ProjectSHE` | ProjectSHE Unity editor/build/test resource. |
| `unity:Shared/Superlazy.Unity.TestHost` | Shared Unity test host resource. |
| `host:process-diagnostics` | Local process inspection and performance diagnosis. |

Current behavior:

- `agentq enter --actor <id> --resource <resource>` advertises active resource ownership.
- `agentq owners --resource <resource>` finds active owners.
- `agentq question --resource <resource>` routes by resource owner.
- Hooks infer resources from command payloads for known commands such as `DDSetup.bat`, `SHESetup.bat`, `DDWeaver`, and Unity `-projectPath`.
- AgentQ meta commands are ignored for resource inference so `agentq owners --resource ...` does not make the caller look like a resource owner.

Recommended public UX:

```bash
agentq enter --actor "$ACTOR" \
  --paths ProjectDD \
  --resource setup-watcher:ProjectDD/DDSetup \
  --responsibility "DD setup watcher"

agentq owners --actor "$OTHER_ACTOR" --resource setup-watcher:ProjectDD/DDSetup

agentq question \
  --actor "$OTHER_ACTOR" \
  --resource setup-watcher:ProjectDD/DDSetup \
  --question "I need to run DD setup/codegen. Are you currently holding the watcher or generated output contract?" \
  --expect "Answer with current watcher state and clear-to-run or blocker evidence."
```

Design rules:

- Resource ids should be explicit strings, not inferred global state.
- Resource ids should be stable and human-readable.
- Resource ownership is soft contact, not a lock.
- Resource questions should ask for fast coordination, not permission from a boss.
- Hook inference should be conservative. False negatives are better than false owner pollution.

Current implementation checks:

- Resource id naming is documented as `<domain>:<workspace-relative-name>` in [`resources.md`](resources.md).
- Custom resources that do not depend on Superlazy are documented in [`resources.md`](resources.md).
- Inferred resources are visible in `agentq diag`.
- `agentq diag activity` shows resource owners and hook gaps so stale policy can be based on observed behavior.

### 3. Non-Polluting Smoke And Demo

The product must not create fake routeable actors while proving itself.

Observed dogfood failure:

- A smoke/test actor held `setup-watcher:ProjectDD/DDSetup`.
- A real agent routed a question to that smoke actor.
- The smoke actor was not a real owner and had to answer `not_mine`.

Policy:

- Smoke tests may write to a temp OS-local store.
- Public demos may create demo actors only when the demo is explicitly about actor routing.
- Diagnostic probes must not create production presence.
- Hook payload experiments must not refresh the real workspace actor pool unless they are testing a real installed hook.

Recommended command split:

| Surface | Writes Presence? | Use |
|---------|------------------|-----|
| `agentq diag` | No | Read hook ring log. |
| `agentq diag activity` | No | Read hook activity and stale signals. |
| `agentq demo ...` | Temp store only | Public reproducible demos. |
| `agentq hook ...` | Yes | Real installed hook path only. |
| `agentq enter ...` | Yes | Real actor presence. |

Near-term implementation plan:

1. Keep package smoke using temporary `LOCALAPPDATA`.
2. Avoid README examples that run fake `agentq hook ...` against a real workspace store.
3. Add `agentq demo collision --dry-run` or a script under `fixtures/demo/` that creates a temporary workspace and temp runtime store.
4. Add a regression test that demo/smoke commands leave the caller workspace with no new actor presence.
5. Keep `agentq diag activity` read-only.

Acceptance criteria:

- Running package smoke does not add actors to the user's active workspace.
- Running public demo commands either use a temp store or clearly create demo actors as the subject of the demo.
- `agentq status` after docs smoke does not show `smoke`, `diag`, or `test` actors as active owners in the real workspace.

### 4. Stale Policy Observation

Do not change the default stale window yet.

Reason:

- Active agents often refresh every few seconds or minutes during normal tool use.
- Long builds, Unity runs, test suites, user-input waits, or long reasoning turns may create legitimate gaps.
- A stale window that is too short hides live owners.
- A stale window that is too long leaves finished or smoke actors routeable.

Current observation command:

```bash
agentq diag activity --window 24h --limit 40
agentq status --stale-ms 900000
agentq status --stale-ms 1800000
agentq status --stale-ms 3600000
agentq status --stale-ms 7200000
```

Collect at least one day of dogfood data before changing the default.

Decision evidence to capture:

- active actor count at 15m / 30m / 1h / 2h
- p95 hook gap for active agents
- max hook gap for agents with open work
- whether any active work actor would be lost below 1h
- whether pending inbox targets are stale under each threshold
- whether resource owners remain fresh during long tool runs

Default policy should only change when the observation shows it would reduce noise without hiding actors with live work or pending replies.

### 5. Instruction Quality Tests

AgentQ only works if the agent actually uses it at the right moments.

The executable checklist lives in [`instruction-quality-checklist.md`](instruction-quality-checklist.md).

The instruction quality test should verify behavior, not prose.

Required behavior scenarios:

| Scenario | Expected Agent Behavior |
|----------|-------------------------|
| Start non-trivial work | Identify actor id, check `inbox`, check/open `work`, refresh concrete scope. |
| Before shared edit | Run `owners --path` for relevant paths. |
| Before soft-exclusive tool | Run `owners --resource` for the resource. |
| Owner found | Send `question` or `block` instead of silently proceeding. |
| Receives inbox | Answer with `respond` and evidence. |
| Finishing | Close active work, run `done-check`, do not claim done if it fails. |
| Broad actor scope | Run `enter --actor ... --paths ... --responsibility ...` to narrow scope. |
| Hook diagnostic confusion | Use `diag` / `diag activity` rather than guessing. |

Manual test matrix:

| Agent Surface | Instruction File | Hook Surface | Must Verify |
|---------------|------------------|--------------|-------------|
| Codex CLI | `AGENTS.md` | `.codex/hooks.json` | Stop gate blocks unresolved work/replies. |
| Claude Code | `CLAUDE.md` | `.claude/settings.json` | Required inbox is visible and answerable. |
| Copilot CLI | `.github/instructions/agentq.instructions.md` | `.github/hooks/agentq.json` | Agent stop gate and explicit actor id usage. |
| Custom CLI | user prompt | manual commands | `enter`, `owners`, `question`, `done-check` flow. |

Pass criteria:

- The agent does not rely on `agentq current` or any implicit "me".
- Every stateful command passes explicit `--actor`.
- The agent refreshes narrow scope before relying on routing.
- The agent asks the owner when `owners` reports overlap.
- `done-check` failure changes the final answer path.
- The agent distinguishes AgentQ queue/work evidence from sub-agent review.

Regression prompt shape:

```text
You are about to modify src/protocol.ts. Another actor owns src/protocol.ts.
Use AgentQ correctly and report whether you can proceed.
```

Expected transcript:

1. `agentq owners --actor <self> --path src/protocol.ts`
2. `agentq question --actor <self> --to <owner> --path src/protocol.ts ...`
3. no claim of completion until `respond` exists and `done-check` passes

Do not treat instruction tests as model preference tests. They should be small reproducible scenarios with expected command transcripts.

## Next Concrete Work

1. Add a temp-store collision demo transcript.
2. Add resource id naming docs and a custom-resource example.
3. Add a non-polluting demo/smoke check.
4. Run `diag activity` for one day before stale-window changes.
5. Build a small instruction quality test checklist per agent surface.
