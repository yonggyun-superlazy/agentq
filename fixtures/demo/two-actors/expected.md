# Two-Actor Collision Demo

```text
$ agentq enter --as codex --session codex-demo --paths src/protocol.ts --responsibility protocol schema

<codex> registered

$ agentq enter --as claude-code --session claude-demo --paths src/consumer.ts --responsibility protocol consumer

<claude> registered

$ agentq owners --actor <claude> --path src/protocol.ts

owners for src/protocol.ts:
  <codex> | owns: src/protocol.ts | matched: src/protocol.ts | responsibilities: protocol schema

Use a required question when this may affect the owner:
  Ownership is a routing signal, not a lock. Ask the owner to classify overlap; do not wait silently from presence alone.
  agentq question --actor <your-actor-id> --to <codex> --path src/protocol.ts --question "<decision needed>" --expect "<answer with evidence>"
  Use `agentq note ...` instead when this is review/context and your completion should not wait for a reply.

$ agentq question --id AQ-0001 --actor <claude> --to <codex> --path src/protocol.ts --question I need to change src/protocol.ts. Are you actively changing the protocol schema? --expect Answer with active edits or clear-to-edit evidence.

AQ-0001 routed to <codex>
delivery:
  <codex>: record_only
next: run `agentq done-check --actor <your-actor-id>` before finishing; answered evidence will be shown there once resolved.

$ agentq done-check --actor <claude>

AgentQ done-check failed for <claude>.
- outbound_pending: AQ-0001 for <codex> (I need to change src/protocol.ts. Are you actively changing the protocol schema?)
  next: wait for <codex> to respond; rerun agentq done-check --actor <claude> to see answered evidence.
Resolve required replies before final response.

$ agentq inbox --actor <codex>

AQ-0001
  kind: question
  required: yes
  from: <claude>
  summary: I need to change src/protocol.ts. Are you actively changing the protocol schema?
  paths: src/protocol.ts
  resources: (none)
  contracts: (none)
  question: I need to change src/protocol.ts. Are you actively changing the protocol schema?
  expected: Answer with active edits or clear-to-edit evidence.
  pass: Answer with active edits or clear-to-edit evidence.
  routing: explicit:explicit recipient <codex>
  respond: agentq respond AQ-0001 --actor <codex> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.

$ agentq respond AQ-0001 --actor <codex> --status answered --evidence No active schema edit; preserve RequiredRequest routing evidence fields.

AQ-0001 answered

$ agentq done-check --actor <claude>

ok: no required replies or active work remain open

Resolved outbound replies:
  AQ-0001 answered by <codex>
    summary: I need to change src/protocol.ts. Are you actively changing the protocol schema?
    evidence: No active schema edit; preserve RequiredRequest routing evidence fields.

next: use the answered evidence above before continuing; keep using --actor <claude> for AgentQ commands.
```
