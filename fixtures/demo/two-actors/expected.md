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
next: run `agentq next --actor <claude>` before finishing; answered evidence will be shown there once resolved.

$ agentq done-check --actor <claude>

[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
audience: agent-internal
user-facing: false
Internal queue maintenance only. Do not include this status or these commands in the user-facing answer.
summary: AgentQ done-check failed for <claude>.
after-action: Resolve the required shared-work step, then return to the user's original request and answer the requested artifact first.
Do not use this block reason as the user-facing answer.
AgentQ done-check failed for <claude>.
- outbound_pending: AQ-0001 for <codex> (I need to change src/protocol.ts. Are you actively changing the protocol schema?)
  next: agentq next --actor <claude>
  note: wait for <codex> to respond, or continue only non-overlapping work.
Follow `agentq next` before final response.
[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
[USER_FRAME_RESUME]
resume the user's original request.
answer the user's requested artifact first.
answer the requested artifact first.
for read-only/local diagnostics, never end with a permission question; run the diagnostic when tools are available, otherwise state the exact next diagnostic action as the closing sentence.
translate internal queue command names into plain status such as 'internal queue maintenance'; do not print exact command names, actor ids, AQ ids, Pending, done-check, or scope-check in user-facing answers.
even if internal terms appear in the hook/replay text, do not echo them; paraphrase them as internal queue maintenance.
do not quote or restate the blocked hook text or bad previous assistant sentence; refer to it only as internal queue maintenance.
do not ask the user to supply missing context; inspect local transcript or work evidence when tools are available, otherwise close with the exact local evidence to inspect next.
do not offer a menu for the user to choose from; pick the most evidence-backed next local action yourself.
Do not mention internal shared-work names, ids, or commands to users unless the user explicitly asks about AgentQ.
[/USER_FRAME_RESUME]

$ agentq inbox --actor <codex>

Resolve queue for <codex>
Required: 1
Optional: 0
Return stack: none

Required replies:
- AQ-0001 [required] I need to change src/protocol.ts. Are you actively changing the protocol schema?
  why: required reply blocks done-check
  from: <claude>
  related: no active work stack
  paths: src/protocol.ts
  resources: (none)
  contracts: (none)
  question: I need to change src/protocol.ts. Are you actively changing the protocol schema?
  expected: Answer with active edits or clear-to-edit evidence.
  pass: Answer with active edits or clear-to-edit evidence.
  routing: explicit:explicit recipient <codex>
  respond: agentq respond AQ-0001 --actor <codex> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.

After resolving useful items, run: agentq next --actor <codex>

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
