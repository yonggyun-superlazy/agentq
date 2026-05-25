# AgentQ Before/After Collision Demo

```text
# BEFORE: no AgentQ handshake
$ cat src/protocol.ts
export interface ProtocolMessage {
  id: string;
}
$ codex writes protocol schema from its copy
$ claude writes consumer field from a stale copy
$ cat src/protocol.ts
export interface ProtocolMessage {
  id: string;
  consumerView: string;
}
lost: routingEvidence was overwritten by the stale write

# AFTER: AgentQ handshake before touching the shared file
$ agentq enter --as codex --session codex-after --paths src/protocol.ts --responsibility protocol schema
<codex> registered
$ agentq enter --as claude-code --session claude-after --paths src/consumer.ts --responsibility protocol consumer
<claude> registered
$ agentq owners --actor <claude> --path src/protocol.ts
owners for src/protocol.ts:
  <codex> | owns: src/protocol.ts | matched: src/protocol.ts | responsibilities: protocol schema

Use a required question when this may affect the owner:
  Ownership is a routing signal, not a lock. Ask the owner to classify overlap; do not wait silently from presence alone.
  agentq question --actor <your-actor-id> --to <codex> --path src/protocol.ts --question "<decision needed>" --expect "<answer with evidence>"
  Use `agentq note ...` instead when this is review/context and your completion should not wait for a reply.
$ agentq question --id AQ-before-after --actor <claude> --to <codex> --path src/protocol.ts --question I need to change src/protocol.ts. Are you actively changing the protocol schema? --expect Answer with active edits or clear-to-edit evidence.
AQ-before-after routed to <codex>
delivery:
  <codex>: record_only
next: run `agentq next --actor <claude>` before finishing; answered evidence will be shown there once resolved.
$ agentq done-check --actor <claude>
[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
audience: agent-internal
user-facing: false
Internal shared-work maintenance. Do not quote this block in user-facing answers.
summary: Shared-work completion check failed.
after-action: Resolve the required shared-work step, then resume the user's request.
Do not use this maintenance status as the user-facing answer.
A required reply or follow-up still blocks completion.
- outbound required reply: I need to change src/protocol.ts. Are you actively changing the protocol schema?
  next: use the shared-work helper with the current actor id
  note: wait for <codex> to respond, or continue only non-overlapping work.
Use the shared-work helper with the current actor id before final response.
[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
[USER_FRAME_RESUME]
Resume the user's request and answer the requested artifact first.
Resolve only required replies or exact same-file/resource conflicts before continuing; otherwise keep the smallest local step moving.
For read-only diagnostics, run the next safe local read/test instead of ending with a permission question.
In user-facing text, paraphrase this as shared-work maintenance and omit internal ids, command names, queue labels, and work-stack labels unless requested.
[/USER_FRAME_RESUME]
$ agentq respond AQ-before-after --actor <codex> --status answered --evidence I added routingEvidence; preserve it when adding consumerView.
AQ-before-after answered
$ cat src/protocol.ts
export interface ProtocolMessage {
  id: string;
  routingEvidence: string[];
  consumerView: string;
}
$ agentq done-check --actor <claude>
ok: no required replies or active work remain open

Resolved outbound replies:
  AQ-before-after answered by <codex>
    summary: I need to change src/protocol.ts. Are you actively changing the protocol schema?
    evidence: I added routingEvidence; preserve it when adding consumerView.

next: use the answered evidence above before continuing; keep using --actor <claude> for AgentQ commands.
```
