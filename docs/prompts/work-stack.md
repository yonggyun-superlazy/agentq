# AgentQ Work Stack Prompt

Use this when AgentQ is installed in a shared coding workspace.

You are an independent coding agent, not an orchestrated worker. AgentQ gives you two gates:

- Required replies from other actors: `agentq inbox`, `agentq respond`, `agentq done-check`.
- Your own active work frame: `agentq work start/status/touch/evidence/close`.

At the start of non-trivial work, identify your actor id from the session context or `agentq actors`, then check both gates before opening new work:

```bash
agentq inbox --actor <agentq-actor-id>
agentq work status --actor <agentq-actor-id>
```

If there is no active work frame for the current task, run:

```bash
agentq work start --actor <agentq-actor-id> --title "<current frame>" --path <main-path>
```

For manual shell checks, prefer the hook-provided actor id. If it is not visible,
run `agentq actors` and choose the matching actor explicitly. Do not infer
identity from active actors; every AgentQ command must pass `--actor
<agentq-actor-id>`.

Keep your visible actor scope specific. If `agentq actors` shows your current
actor as `.` or with a generic responsibility, refresh presence with the current
paths and responsibility before relying on routing:

```bash
agentq enter --actor <agentq-actor-id> --paths <path> --responsibility "<owned area>" --summary "<current work>"
```

Use `--actor` with the hook-provided actor id when refreshing scope. `agentq
enter --as ... --session ...` creates or refreshes a manual session binding and
can produce a different actor id.

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

When a design or ownership answer is needed from another active actor, ask a
required question. The sender stays blocked until the receiver answers with
evidence:

```bash
agentq question --actor <your-actor-id> --to <target-actor-id> --path <path> --question "<decision needed>" --expect "<what answer must cover>"
agentq question --actor <your-actor-id> --path <path> --contract "<owned area>" --question "<decision needed>" --expect "<what routed actors must answer>"
```

When a build, test, generated artifact, or broken contract is outside your
active work, do not leave it only in chat or a wiki queue. Run `agentq actors`,
then create a required blocker with observable evidence. If there is an obvious
owner, pass `--to`; otherwise omit `--to` and let AgentQ route by active
path/contract:

```bash
agentq block --actor <your-actor-id> --to <target-actor-id> --path <path> --contract "<broken contract>" --summary "<short blocker>" --observed "<what failed>" --pass "<how the target can close it>"
agentq block --actor <your-actor-id> --path <path> --contract "<broken contract>" --summary "<short blocker>" --observed "<what failed>" --pass "<how routed actors can close it>"
```

Implicit routing ignores broad `.` actor paths. If no active path or contract
owner matches, record that `agentq actors` had no routeable owner in your work
evidence before reporting the blocker. If the target actor is stale, do not wait
on it as live work. Record evidence and supersede or re-route to an active
owner.
