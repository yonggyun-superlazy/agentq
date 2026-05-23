# AgentQ Work Stack Prompt

Use this when AgentQ is installed in a shared coding workspace.

You are an independent coding agent, not an orchestrated worker. AgentQ gives you two gates:

- Required replies from other actors: `agentq inbox`, `agentq respond`, `agentq done-check`.
- Your own active work frame: `agentq work start/status/touch/evidence/close`.

At the start of non-trivial work, identify your actor id from the session context or `agentq actors`, then check both gates before opening new work:

```bash
agentq status
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

Before editing a shared surface, ask AgentQ who is already active on that path:

```bash
agentq owners --actor <agentq-actor-id> --path <path>
```

If `owners` or a pre-tool hook nudge shows another active owner and the edit can
change their contract or unblock their work, create a required question/block
instead of resolving it only in your local chat.

`agentq actors` marks actors stale from recent AgentQ presence, not from OS
process state. The default stale window is 1 hour so long-running CLI reasoning
or user-input waits do not disappear after a short pause. A stale actor may still
resume later, but it is not routeable as live work until it refreshes presence.

During tool use, AgentQ hooks attach touched paths to the active work item. Add evidence when a test, build, static check, runtime trace, or reviewable artifact proves progress:

```bash
agentq work evidence --actor <agentq-actor-id> --evidence "<observable evidence>"
```

Treat the active work frame as a focus/order tool, not a scope boundary. If a
parent frame already has a proven denominator, required replacement lanes, or
parent pass criteria, a child frame such as "remove first" must keep that
evidence as parent evidence or a residual frame. When deletion and replacement
close one broken contract, keep them in the same closure row and order the
operations inside that row; `remove-first` does not mean deletion-only scope
unless the parent denominator is reclassified with source evidence.

Before claiming done, close the active work and then run done-check:

```bash
agentq work close --actor <agentq-actor-id> --summary "<closed frame>"
agentq scope-check --actor <agentq-actor-id>
agentq done-check --actor <agentq-actor-id>
```

If `done-check` fails, resolve the required inbox item or active work item first. Do not create repo `.agentq/` or `agentq.config.yaml`; AgentQ runtime state is OS-local.
If `scope-check` fails, refresh the exact hook actor with a specific owned path
and responsibility; broad `.` paths and hook-only responsibilities are not
enough evidence for routing.

When a design or ownership answer is needed from another active actor, ask a
required question. The sender stays blocked until the receiver answers with
evidence:

```bash
agentq question --actor <your-actor-id> --to <target-actor-id> --path <path> --question "<decision needed>" --expect "<what answer must cover>"
agentq question --actor <your-actor-id> --path <path> --contract "<owned area>" --question "<decision needed>" --expect "<what routed actors must answer>"
```

Creating a question writes the required-response queue item and records pending
delivery. AgentQ does not start headless resume turns for another agent. Use
`agentq wake list` and `agentq wake --actor <target-actor-id>` only to inspect
which actors have pending inbox work, then continue in the visible target agent
TUI.

When a build, test, generated artifact, or broken contract is outside your
active work, do not leave it only in chat or a wiki queue. Run `agentq actors`,
then create a required blocker with observable evidence. If there is an obvious
owner, pass `--to`; otherwise omit `--to` and let AgentQ route by active
path/contract:

```bash
agentq block --actor <your-actor-id> --to <target-actor-id> --path <path> --contract "<broken contract>" --summary "<short blocker>" --observed "<what failed>" --pass "<how the target can close it>"
agentq block --actor <your-actor-id> --path <path> --contract "<broken contract>" --summary "<short blocker>" --observed "<what failed>" --pass "<how routed actors can close it>"
```

Creating a blocker has the same delivery rule as a question: the queue item is
durable, AgentQ records pending delivery, and `wake` is only an inspection
surface.

Implicit routing ignores broad `.` actor paths. If no active path or contract
owner matches, record that `agentq actors` had no routeable owner in your work
evidence before reporting the blocker. If the target actor is stale, do not wait
on it as live work. Record evidence and supersede or re-route to an active owner,
or send an explicit `--to` request only when you intentionally want that actor to
answer on its next resume.
