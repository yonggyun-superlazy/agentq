# AgentQ Product Roadmap

AgentQ is a shared-workspace coordination gate for independent coding agents.

It should not drift into a general messaging app, an orchestrator, a hidden resume system, or a file lock manager. The product test is simple: when agents share a workspace, AgentQ should make ownership, required questions, active work, and completion gates visible enough that agents stop silently stepping on each other.

## Briefing Progress

Every AgentQ progress briefing should include this table or an updated equivalent.

| Area | Status | Evidence | Next Check |
|------|--------|----------|------------|
| Core queue and done gate | Shipped | `question`, `block`, `note`, `respond`, `done-check`, work stack tests | Keep regression tests green. |
| Actor presence and scope | Shipped, noisy history remains | `status`, `actors`, `scope-check`; broad active actor count visible; `work start` rejects missing or broad `--path` | Watch for remaining broad actors created by hook-only sessions. |
| Path owner matching | Shipped | Absolute workspace paths and comma-separated legacy path values are tested | Watch dogfood `owners --path` misses. |
| Resource coordination | Shipped baseline | `enter --resource`, `owners --resource`, hook inference, resource demo transcript | Add more real non-Superlazy resource examples. |
| Contextual next-step UX | Shipped baseline | `owners`, routed delivery, queue/stack-aware `inbox`, stack-aware `work status`, `status`, and successful `done-check` print next actions without adding outbox/current commands | Watch dogfood cases where agents still ask what command to run next. |
| Non-polluting demos | Shipped baseline | demo scripts and package smoke use temp stores | Add explicit no-real-store-pollution assertion. |
| Hook diagnostics | Shipped | `diag`, `diag activity`, 10,000-event ring, ignored meta command logging, declared scope and open-work evidence counts in activity output, heartbeat refresh for already-specific actors on pathless tools, read-only shell path observation without owner/work nudges, and per-agent activity breakdown by tool mode/nudge class/diagnosis | Watch for tool payloads that still only infer `paths:.`. |
| Instruction quality | Shipped baseline | checklist, executable protocol fixture, queue/stack A/B fixture, and cross-CLI inbox probe | Add a Codex-specific fixture and keep real CLI probes small. |
| Cross-CLI proof | Partial | Claude Code and Copilot CLI both answered required inbox probes; Copilot hook events observed with prompt-mode repo-hook opt-in | Verify Copilot stop gate blocking with a pending inbox/work item. |
| Public release readiness | Partial | package smoke, metadata, install/uninstall, README | Confirm npm ownership and publishing path. |
| Stale policy | Observing | 1h default, `diag activity` gap data, evidence-based `work close --status abandoned|superseded` cleanup | Keep collecting live gap data before changing default. |

## Current Product Thesis

AgentQ should win on a narrower promise:

> Required-response queues and completion gates for coding agents sharing one workspace.

The strongest product wedge is not chat. It is the combination of:

- concrete owner discovery for paths and resources
- required questions when an owner overlap matters
- live work stacks that keep interrupts aligned with parent work
- hook-based reminders that stay local and visible
- diagnostics that explain why an actor is or is not routeable
- contextual next-step output so agents do not memorize extra interfaces
- queue/stack A/B fixtures so agent answer quality can be compared with the guidance enabled and disabled

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
- Queue/stack A/B review fixture: [`../fixtures/eval/agent-behavior/queue-stack-ab.md`](../fixtures/eval/agent-behavior/queue-stack-ab.md).

Next:

- Add a Codex-specific transcript and keep the cross-CLI inbox probe fixture current.
- Use the A/B fixture with live Codex, Claude Code, and Copilot sessions, then record which surface produces fewer missed required replies and fewer lost return frames.
- Dogfood missed-return-frame case, 2026-05-25: a child work item was closed after fixture/test evidence, but the parent denominator was not rechecked or briefed. Implemented: child close restores the parent frame, prints parent objective/denominator/pass/next, `next` requires parent-return evidence, parent close fails until fresh parent-return evidence is recorded or supplied at close, and generic child evidence no longer clears the parent-return requirement. Remaining quality work: require richer clause-level evidence for briefing/cause/plan requests, such as explicit parent contract, verified behavior, residual frame, and parent evidence rechecked.

### 4. Cross-CLI Dogfood

Goal: prove the same protocol works across Codex CLI, Claude Code, and Copilot CLI.

Current state:

- Hook files are installed for all three.
- Claude Code and Copilot CLI both answered required inbox probes in a temporary workspace.
- Claude Code hook events were observed during the inbox probe.
- Copilot CLI hook events were observed when prompt-mode repo hooks were enabled with `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true`.
- Without folder trust or that env opt-in, Copilot prompt mode deferred repository hooks and did not run AgentQ.

Next:

- Run a Copilot stop-gate blocker scenario with a pending inbox/work item.
- Run one resource-owner scenario in Copilot CLI with prompt-mode repo hooks enabled.
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
