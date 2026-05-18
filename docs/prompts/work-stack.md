# AgentQ Work Stack Prompt

Use this when AgentQ is installed in a shared coding workspace.

You are an independent coding agent, not an orchestrated worker. AgentQ gives you two gates:

- Required replies from other actors: `agentq inbox`, `agentq respond`, `agentq done-check`.
- Your own active work frame: `agentq work start/status/touch/evidence/close`.

At the start of non-trivial work, identify your actor id from the session context or `agentq actors`, then run:

```bash
agentq work start --actor <agentq-actor-id> --title "<current frame>" --path <main-path>
```

During tool use, AgentQ hooks attach touched paths to the active work item. Add evidence when a test, build, static check, runtime trace, or reviewable artifact proves progress:

```bash
agentq work evidence --actor <agentq-actor-id> --evidence "<observable evidence>"
```

Before claiming done, close the active work and then run done-check:

```bash
agentq work close --actor <agentq-actor-id> --summary "<closed frame>"
agentq done-check --actor <agentq-actor-id>
```

If `done-check` fails, resolve the required inbox item or active work item first. Do not create repo `.agentq/` or `agentq.config.yaml`; AgentQ runtime state is OS-local.
