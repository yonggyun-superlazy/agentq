# Cross-CLI Inbox Probe - 2026-05-23

This is a manual dogfood probe, not an automated test. It used a temporary
workspace and a temporary `LOCALAPPDATA` store so the real workspace actor pool
was not polluted.

## Setup

```powershell
agentq install --yes

$sender = agentq enter --as codex --session probe-sender --paths probe/driver.md --responsibility "Own cross CLI probe driver"
$claude = agentq enter --as claude-code --session claude-probe --paths src/claude.ts --responsibility "Answer Claude Code inbox probe"
$copilot = agentq enter --as copilot-cli --session copilot-probe --paths src/copilot.ts --responsibility "Answer Copilot CLI inbox probe"

agentq question --actor $sender --to $claude --id AQ-PROBE-CLAUDE --path src/claude.ts --question "Please answer this inbox probe from Claude Code CLI." --expect "Run agentq respond with status answered."
agentq question --actor $sender --to $copilot --id AQ-PROBE-COPILOT --path src/copilot.ts --question "Please answer this inbox probe from Copilot CLI." --expect "Run agentq respond with status answered."
```

Observed setup state:

```text
doctor: ok
actors: 4 (active 4, stale 0, staleAfter 1h)
routeable active actors: 4
broad/generic active actors: 0
pending inbox: 2
open work: 0
```

## Claude Code

Command shape:

```powershell
claude -p "<run inbox, respond AQ-PROBE-CLAUDE, done-check>" --dangerously-skip-permissions --add-dir <temp-workspace>
```

Verification after the run:

```text
agentq inbox --actor claude-code@...@claude-probe@...
inbox empty

agentq done-check --actor claude-code@...@claude-probe@...
ok: no required replies or active work remain open
```

Finding:

- Claude Code can consume a required AgentQ inbox item and answer it when the prompt includes the explicit actor id.
- Claude Code hooks fired during the run and refreshed a separate hook session actor with concrete scope. This is useful, but it means "prompt-specified actor" and "hook session actor" still need to stay visible in diagnostics.

## Copilot CLI

Command shape:

```powershell
copilot -C <temp-workspace> -p "<run inbox, respond AQ-PROBE-COPILOT, done-check>" --allow-all-tools --allow-all-paths --no-ask-user --experimental
```

Observed CLI result:

```text
AgentQ probe completed successfully; `done-check` passed.
```

Verification after the run:

```text
agentq inbox --actor copilot-cli@...@copilot-probe@...
inbox empty

agentq done-check --actor copilot-cli@...@copilot-probe@...
ok: no required replies or active work remain open
```

Finding:

- Copilot CLI can consume a required AgentQ inbox item and answer it when the prompt includes the explicit actor id.
- No Copilot hook event appeared in `agentq diag` during this probe. Treat Copilot command execution as proven, but Copilot hook gate activation as still unproven until a dedicated hook-surface test shows events.

## Final State

```text
doctor: ok
actors: 5 (active 5, stale 0, staleAfter 1h)
routeable active actors: 5
broad/generic active actors: 0
pending inbox: 0
open work: 0
stale open work: 0
weak-scope actors: 0
```
