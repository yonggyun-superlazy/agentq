# Resource Coordination

AgentQ resources are soft-exclusive coordination surfaces that are bigger than one file path.

Use a resource when two agents can step on each other even if they edit different files:

- a Unity editor project
- a setup watcher
- a generated output pipeline
- a shared local service
- a host-level diagnostic or process task
- a package manager install/update operation

Resources are not locks. They are contact points for required questions.

## Naming

Use stable, human-readable ids:

```text
<domain>:<workspace-relative-name>
```

Examples:

```text
unity:ProjectDD/DDUnity
unity:Shared/Superlazy.Unity.TestHost
setup-watcher:ProjectDD/DDSetup
codegen:ProjectDD/DDWeaver
host:process-diagnostics
tool:demo/shared-build
package-manager:root
```

Guidelines:

- Prefer lowercase domains.
- Use `/` separators inside workspace-relative names.
- Do not include machine-local absolute paths.
- Do not include transient process ids.
- Keep ids understandable in `agentq owners` output.

## Manual Ownership

An agent can advertise a resource directly:

```bash
agentq enter --actor "$ACTOR" \
  --paths ProjectDD \
  --resource setup-watcher:ProjectDD/DDSetup \
  --responsibility "DD setup watcher"
```

Another agent can check before using the same surface:

```bash
agentq owners --actor "$OTHER_ACTOR" --resource setup-watcher:ProjectDD/DDSetup
```

If the owner matters, ask a required question:

```bash
agentq question \
  --actor "$OTHER_ACTOR" \
  --resource setup-watcher:ProjectDD/DDSetup \
  --question "I need to run DD setup/codegen. Are you currently holding the watcher or generated output contract?" \
  --expect "Answer with current watcher state and clear-to-run or blocker evidence."
```

The sender stays blocked until the resource owner answers.

## Custom Resource Demo

This demo uses a synthetic resource so it works in any repository:

```bash
BUILDER=$(agentq enter --as codex --session builder --paths . --resource tool:demo/shared-build --responsibility "demo shared build" | sed 's/ registered$//')
CALLER=$(agentq enter --as claude-code --session caller --paths docs --responsibility "demo docs caller" | sed 's/ registered$//')

agentq owners --actor "$CALLER" --resource tool:demo/shared-build

agentq question \
  --id AQ-demo-resource \
  --actor "$CALLER" \
  --resource tool:demo/shared-build \
  --question "I need to use the shared demo build tool. Are you currently holding it?" \
  --expect "Answer with clear-to-run or blocker evidence."

agentq done-check --actor "$CALLER"
agentq inbox --actor "$BUILDER"
agentq respond AQ-demo-resource --actor "$BUILDER" --status answered --evidence "Shared demo build tool is clear."
agentq done-check --actor "$CALLER"
```

## Hook Inference

Installed hooks infer some resources from tool command payloads.

Current built-in inference:

| Command Signal | Resource |
|----------------|----------|
| `DDSetup.bat` | `setup-watcher:ProjectDD/DDSetup` |
| `SHESetup.bat` | `setup-watcher:ProjectSHE/SHESetup` |
| `ProjectDD/DDWeaver` | `codegen:ProjectDD/DDWeaver` |
| `Unity -projectPath <path>` | `unity:<workspace-relative-path>` |

AgentQ meta commands are ignored by resource inference, so diagnostics do not accidentally create owners:

```bash
agentq owners --resource unity:ProjectDD/DDUnity
agentq diag activity --window 24h
```

## Design Rule

False owner pollution is worse than a missed nudge.

If a command cannot be inferred confidently, prefer no resource inference and let the agent use explicit `agentq enter --resource ...` or `agentq owners --resource ...`.
