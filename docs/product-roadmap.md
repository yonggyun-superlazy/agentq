# AgentQ Product Roadmap

AgentQ is a shared-workspace coordination gate for independent coding agents.

It should not drift into a general messaging app, an orchestrator, a hidden resume system, or a file lock manager. The product test is simple: when agents share a workspace, AgentQ should make ownership, required questions, active work, and completion gates visible enough that agents stop silently stepping on each other.

## Briefing Progress

Every AgentQ progress briefing should include this table or an updated equivalent.

| Area | Status | Evidence | Next Check |
|------|--------|----------|------------|
| Core queue and done gate | Shipped | `question`, `block`, `respond`, `done-check`, work stack tests | Keep regression tests green. |
| Actor presence and scope | Shipped, noisy history remains | `status`, `actors`, `scope-check`; broad active actor count visible; `work start` rejects missing or broad `--path` | Watch for remaining broad actors created by hook-only sessions. |
| Path owner matching | Shipped | Absolute workspace paths and comma-separated legacy path values are tested | Watch dogfood `owners --path` misses. |
| Resource coordination | Shipped baseline | `enter --resource`, `owners --resource`, hook inference, resource demo transcript | Add more real non-Superlazy resource examples. |
| Non-polluting demos | Shipped baseline | demo scripts and package smoke use temp stores | Add explicit no-real-store-pollution assertion. |
| Hook diagnostics | Shipped baseline | `diag`, `diag activity`, ignored meta command logging | Improve attribution when resource inference looks wrong. |
| Instruction quality | Shipped baseline | checklist, executable protocol fixture, and cross-CLI inbox probe | Add a Codex-specific fixture and keep real CLI probes small. |
| Cross-CLI proof | Partial | Claude Code and Copilot CLI both answered required inbox probes; Claude hook events observed | Verify Copilot hook events and stop gate activation separately. |
| Public release readiness | Partial | package smoke, metadata, install/uninstall, README | Confirm npm ownership and publishing path. |
| Stale policy | Observing | 1h default, `diag activity` gap data | Keep collecting live gap data before changing default. |

## Current Product Thesis

AgentQ should win on a narrower promise:

> Required-response queues and completion gates for coding agents sharing one workspace.

The strongest product wedge is not chat. It is the combination of:

- concrete owner discovery for paths and resources
- required questions when an owner overlap matters
- active work frames that block premature completion
- hook-based reminders that stay local and visible
- diagnostics that explain why an actor is or is not routeable

## Roadmap Lanes

### 1. Correctness Before Features

Goal: `owners`, routing, and done gates must be trusted before adding new surfaces.

Done:

- Explicit actor ids; no `current` or global "me".
- Broad `.` actors are ignored for implicit routing.
- Workspace absolute paths match relative active paths.
- Comma-separated legacy active path values are split for owner matching.
- Resource ids are normalized separately from file paths.

Next:

- Add a no-real-store-pollution regression for demos and smoke tests.
- Add diagnostic hints when an active actor has suspicious comma-separated path values.

### 2. Resource-First Product Proof

Goal: prove AgentQ coordinates shared tools, not just files.

Done:

- Resource names documented in [`resources.md`](resources.md).
- `setup-watcher:*`, `unity:*`, and custom resources are supported.
- Resource transcript fixture: [`../fixtures/demo/resource/expected.md`](../fixtures/demo/resource/expected.md).

Next:

- Add a public custom-resource transcript that does not mention Superlazy.
- Add one real dogfood case where `owners --resource` prevents conflicting tool use.

### 3. Instruction Quality

Goal: make agent behavior testable by transcript, not prose.

Done:

- Checklist: [`instruction-quality-checklist.md`](instruction-quality-checklist.md).
- Work-stack prompt: [`prompts/work-stack.md`](prompts/work-stack.md).
- Executable baseline transcript: [`../fixtures/instruction-quality/expected.md`](../fixtures/instruction-quality/expected.md).

Next:

- Add a Codex-specific transcript and keep the cross-CLI inbox probe fixture current.

### 4. Cross-CLI Dogfood

Goal: prove the same protocol works across Codex CLI, Claude Code, and Copilot CLI.

Current state:

- Hook files are installed for all three.
- Claude Code and Copilot CLI both answered required inbox probes in a temporary workspace.
- Claude Code hook events were observed during the probe.
- Copilot CLI command execution worked, but Copilot hook events were not observed in `diag`.

Next:

- Run a dedicated Copilot hook-surface test and prove `agentStop`/pre-tool events appear in `diag`.
- Run one resource-owner scenario in Copilot CLI after hook-surface proof.
- Keep exact transcripts under `fixtures/`.

### 5. Public Release Readiness

Goal: make the GitHub project credible before npm publish.

Done:

- README focuses on product value before scope/non-goals.
- Package smoke verifies tarballs, global install, hook commands, uninstall cleanup, and metadata.
- Install is dry-run by default and reversible with `agentq uninstall --yes`.

Next:

- Confirm npm package ownership for `agentq` and `@agentq/core`.
- Add release notes that explain the focused shared-workspace positioning.

## Briefing Format

Use this structure in user-facing AgentQ progress reports:

```text
Roadmap status:
- Core queue/done gate: shipped
- Resource coordination: shipped baseline
- Instruction quality: in progress
- Cross-CLI proof: partial
- Release readiness: partial

This turn changed:
- ...

Evidence:
- tests / demos / status / diag

Open risk:
- ...
```
