# AgentQ

The handshake between coding agents.

Required-response queues and completion gates for agents sharing one workspace.

## Coordination, not orchestration

AgentQ does not create a boss agent, assign tasks, run a dashboard, or merge work. It gives independent coding agents a local protocol for the moment when one agent finds a blocker that another agent must answer before either side can honestly finish.

```text
Claude Code edits the UI contract.
Codex changes the shared parser.
Copilot updates project instructions.

One agent finds a blocker.
AgentQ routes it to the responsible actor.
The receiver must resolve, answer, reject, or provide blocked evidence.
The sender cannot pass done-check while the required reply is open.
An agent also cannot pass done-check while its own active work frame is still open.
```

## Quickstart

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint:md-snippets
pnpm demo:test
pnpm --filter agentq build
```

The current build proves the public command surface, package layout, OS-local queue core, reversible instruction marker install, and local hook gate install. The first runnable demo is simulated, so it does not require Claude Code, Codex, or Copilot to be installed.

```bash
agentq() { node packages/cli/dist/main.js "$@"; }
MSG_ID="AQ-$(date +%s)"
CODEX_ACTOR=$(agentq enter --as codex --session codex-demo --paths "packages/core/src/**" --responsibility "protocol schema" | sed 's/ registered$//')
CLAUDE_ACTOR=$(agentq enter --as claude-code --session claude-demo --paths "README.md" --responsibility "public docs" | sed 's/ registered$//')
agentq block --id "$MSG_ID" --actor "$CODEX_ACTOR" --to "$CLAUDE_ACTOR" --path README.md --summary "README promises config that protocol forbids"
agentq inbox --actor "$CLAUDE_ACTOR"
agentq respond "$MSG_ID" --actor "$CLAUDE_ACTOR" --status resolved --evidence "README now says no config and no repo .agentq"
agentq done-check --actor "$CODEX_ACTOR"
```

Scripted fixed-id transcript: [`fixtures/demo/two-actors/expected.md`](fixtures/demo/two-actors/expected.md).

## Delivery Inspection

AgentQ does not assign work or create a boss agent. When `question` or `block` routes a request, AgentQ writes the durable queue item, checks the recipient session binding, and records pending delivery without starting another agent process.

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

## Local Install

From a source checkout:

```bash
pnpm install
pnpm build
pnpm package:smoke
node packages/cli/dist/main.js install --dry-run
node packages/cli/dist/main.js doctor
```

`agentq install --dry-run` is the default inspection mode. Hook files contain `agentq hook ...` commands, so run `install --yes` for real hook gates only from an installed `agentq` binary that is on `PATH`.

## Agent prompt

Use [`docs/prompts/work-stack.md`](docs/prompts/work-stack.md) as the handoff prompt for agents that need explicit work-stack discipline. It keeps the actor id, required replies, active work frames, evidence, and done-check in one copyable instruction surface.

## Install trust

`agentq install` is designed to be boring and inspectable. It installs AgentQ-owned instruction markers and hook entries for Codex, Claude Code, and Copilot without removing existing hook entries.

- Dry-run first: print touched files, marker blocks, hook commands, and uninstall command.
- Mutate only with `--yes`.
- Keep runtime queue state outside the repository in an OS-local workspace store.
- Use `agentq status` for a one-screen health summary: doctor result, active/stale actors, pending inboxes, open work, and weak-scope counts.
- Use `agentq owners --path <path>` before editing shared surfaces. Pre-tool hooks also emit a non-blocking owner nudge when a mutating tool path overlaps another active actor.
- Use `agentq actors` to inspect active/stale actor presence before routing blockers. Active means recent AgentQ presence, not a guaranteed live OS process; the default stale window is 1 hour.
- Use `agentq scope-check --actor <id>` before finishing. It fails broad `.` paths and generic hook responsibilities so agents refresh concrete ownership.
- Out-of-scope build, test, or generated-artifact failures should become required AgentQ blockers with observable evidence, not chat-only notes.
- No `agentq.config.yaml`.
- No default repo `.agentq/`.
- No `--store` escape hatch.

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
