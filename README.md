# AgentQ

The handshake between coding agents.

AgentQ is a required-response queue and completion gate for independent coding agents sharing one workspace.
Required-response queues and completion gates are the core primitive: when an agent needs an answer, AgentQ records the question and keeps both sides from claiming done until the answer is resolved.

When multiple agents edit the same repo, one stale write or unasked ownership question can erase another agent's work. AgentQ gives those agents a local handshake: declare scope, find active owners, ask required questions, answer with evidence, and block "done" until the queue is clear.

## How It Works

- `enter`: declare the files or resources an actor is responsible for.
- `owners`: find active actors on a path or soft-exclusive resource.
- `question` / `block`: create a required request when another actor must answer.
- `respond`: resolve the request with evidence.
- `done-check`: fail if required replies or active work remain open.

## Before And After

Without AgentQ, two agents can write from stale local context and silently lose each other's changes:

```text
Codex adds routingEvidence to src/protocol.ts.
Claude writes consumerView from an older copy.
Result: routingEvidence disappears.
```

With AgentQ, the second agent finds the owner and cannot finish until the required answer arrives:

```text
agentq owners --actor <claude> --path src/protocol.ts
agentq question --actor <claude> --to <codex> --path src/protocol.ts --question "Can I change this?"
agentq done-check --actor <claude>   # fails while the answer is pending
agentq respond AQ-... --actor <codex> --status answered --evidence "Preserve routingEvidence."
agentq done-check --actor <claude>   # passes
```

Scripted fixed-id transcript: [`fixtures/demo/two-actors/expected.md`](fixtures/demo/two-actors/expected.md). The before/after collision transcript is [`fixtures/demo/before-after/expected.md`](fixtures/demo/before-after/expected.md), the soft-exclusive resource transcript is [`fixtures/demo/resource/expected.md`](fixtures/demo/resource/expected.md), and the instruction behavior transcript is [`fixtures/instruction-quality/expected.md`](fixtures/instruction-quality/expected.md).

## Quickstart

From a source checkout:

```bash
pnpm install
pnpm build
pnpm package:smoke
node packages/cli/dist/main.js install --dry-run
node packages/cli/dist/main.js doctor
```

The runnable demos are simulated in a temporary workspace, so they do not require Claude Code, Codex, Copilot, Unity, or a project-specific repo.

```bash
pnpm demo:test
```

## Local Install

`agentq install --dry-run` is the default inspection mode. It prints touched files, marker blocks, hook commands, and the uninstall command. Run `install --yes` for real hook gates only from an installed `agentq` binary that is on `PATH`.

```bash
agentq install --dry-run
agentq install --yes
agentq doctor
```

## Delivery Inspection

When `question` or `block` routes a request, AgentQ writes the durable queue item, checks the recipient session binding, and records pending delivery. `agentq wake` lets you inspect those pending delivery targets:

`agentq wake` is inspection-only. It finds actors with pending required requests and prints the inbox command the visible target agent should run. It does not call `codex exec resume`, `claude -p --resume`, Copilot non-interactive resume, or any other headless resume path.

```bash
agentq wake list
agentq wake --actor "$CLAUDE_ACTOR"
agentq wake --all
```

Headless resume is intentionally not part of AgentQ delivery:

- Hidden resume turns can edit files or answer queues without updating the visible TUI.
- Existing unmanaged TUI processes do not expose a reliable cross-CLI wake channel.
- Future managed TUI or remote-control transports must prove visible delivery before they become AgentQ delivery targets.

## Agent prompt

Use [`docs/prompts/work-stack.md`](docs/prompts/work-stack.md) as the handoff prompt for agents that need explicit work-stack discipline. It keeps the actor id, required replies, active work frames, evidence, and done-check in one copyable instruction surface.

## Product focus

AgentQ is being validated as a narrow shared-workspace coordination layer, not a general messaging app. See [`docs/product-roadmap.md`](docs/product-roadmap.md) for the progress table used in briefings. See [`docs/focused-product-validation.md`](docs/focused-product-validation.md) for the collision demo, resource-first UX, non-polluting smoke/demo, stale-window observation, and instruction quality test plan. Resource naming lives in [`docs/resources.md`](docs/resources.md), and agent behavior checks live in [`docs/instruction-quality-checklist.md`](docs/instruction-quality-checklist.md).

## Install trust

`agentq install` is designed to be boring and inspectable. It installs AgentQ-owned instruction markers and hook entries for Codex, Claude Code, and Copilot without removing existing hook entries.

- Dry-run first: print touched files, marker blocks, hook commands, and uninstall command.
- Mutate only with `--yes`.
- Keep runtime queue state outside the repository in an OS-local workspace store.
- Use `agentq status` for a one-screen health summary: doctor result, active/stale actors, pending inboxes, open work, and weak-scope counts.
- Use `agentq diag` for the OS-local hook diagnostic ring log when scope/resource inference looks noisy.
- Use `agentq owners --path <path>` before editing shared surfaces and `agentq owners --resource <resource>` before touching soft-exclusive tools such as `setup-watcher:ProjectDD/DDSetup` or `unity:ProjectDD/DDUnity`. Pre-tool hooks also emit a non-blocking owner nudge when a mutating tool path or inferred resource overlaps another active actor.
- Use `agentq actors` to inspect active/stale actor presence before routing blockers. Active means recent AgentQ presence, not a guaranteed live OS process; the default stale window is 1 hour.
- Use `agentq scope-check --actor <id>` before finishing. It fails broad `.` paths and generic hook responsibilities so agents refresh concrete ownership.
- Out-of-scope build, test, or generated-artifact failures should become required AgentQ blockers with observable evidence, not chat-only notes.
- No `agentq.config.yaml`.
- No default repo `.agentq/`.
- No `--store` escape hatch.

## Scope

Coordination, not orchestration: AgentQ does not create a boss agent, assign tasks, run a dashboard, merge work, lock files, or run hidden headless agent turns. It gives independent agents a local protocol for the moment when one agent needs an answer from another before either side can honestly finish.

## Supported agents

| Agent surface | Role | Gate |
|---------------|------|------|
| Codex CLI | Local coding agent | `Stop` hook blocks unresolved required replies or active work |
| Claude Code | Local coding agent | `Stop` hook blocks unresolved required replies or active work |
| GitHub Copilot CLI | Local coding agent | `agentStop` hook blocks unresolved required replies or active work |
| GitHub Copilot cloud agent | Remote/sandboxed agent | Advisory until a shared remote transport exists |
| Custom CLI | Local actor | Uses explicit `agentq enter`, `block`, `respond`, `done-check` |

## Files touched by install

| Surface | Commit? | Purpose |
|---------|---------|---------|
| `AGENTS.md` marker | Usually yes | Shared instruction marker for Codex-compatible agents |
| `.codex/hooks.json` | Team choice | Codex project hook gate |
| `CLAUDE.md` marker | Team choice | Claude Code instruction marker |
| `.claude/settings.json` hook | Team choice | Claude Code project hook gate |
| `.github/hooks/agentq.json` | Yes for Copilot projects | Copilot hook gate |
| `.github/instructions/agentq.instructions.md` | Yes for Copilot projects | Copilot instruction marker |
| OS-local AgentQ store | Never | Runtime messages, actor presence, session bindings |

The OS-local store also holds each actor's active work stack. Long-lived project docs can stay in a wiki or README; the in-flight frame that blocks a final answer belongs in AgentQ.

## Uninstall

```bash
agentq uninstall --dry-run
agentq uninstall --yes
agentq doctor
```

Uninstall removes only AgentQ-owned marker blocks and hook entries. Existing project instructions and non-AgentQ hooks are preserved.

## Current Limits

- AgentQ is local to one workspace path and one machine.
- Copilot cloud agent support is advisory until AgentQ has a remote/shared transport.
- Codex project-local hook trust still needs review in Codex with `/hooks` when Codex reports new or changed hooks.

## Release Readiness

The repository is private while the public release surface is being prepared.

- License: MIT.
- Publishable packages: `agentq` and `@agentq/core`.
- Release version target: `0.1.0`.
- CI runs build, typecheck, tests, README lint, demo transcript, and package smoke on Windows, Ubuntu, and macOS.
- Package smoke packs the tarballs, installs them globally into a temporary prefix, runs installed hook commands through `PATH`, and verifies uninstall cleanup.

Before the first npm publish, confirm npm ownership for the `agentq` package and the `@agentq` scope, then configure npm trusted publishing or an equivalent release credential.

## Why this exists

Parallel coding agents do not always need a supervisor. They do need a handshake when they share a workspace.

AgentQ is that handshake: a required-response queue plus a completion gate.
