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
Internal queue maintenance only. Do not include this status or these commands in the user-facing answer.
summary: AgentQ done-check failed for <claude>.
after-action: Resolve the required shared-work step, then return to the user's original request and answer the requested artifact first.
Do not use this block reason as the user-facing answer.
AgentQ done-check failed for <claude>.
- outbound_pending: AQ-before-after for <codex> (I need to change src/protocol.ts. Are you actively changing the protocol schema?)
  next: agentq next --actor <claude>
  note: wait for <codex> to respond, or continue only non-overlapping work.
Follow `agentq next` before final response.
[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
[USER_FRAME_RESUME]
resume the user's original request.
answer the user's requested artifact first.
answer the requested artifact first.
owner overlap, broad scope, and zero-evidence work are diagnostics, not stop conditions; keep the smallest non-overlapping local step moving unless a required reply or exact same-file/resource conflict blocks it.
for read-only/local diagnostics, never end with a permission question; run the diagnostic when tools are available, otherwise state the exact next diagnostic action as the closing sentence.
translate internal queue command names into plain status such as 'internal queue maintenance'; do not print exact command names, actor ids, AQ ids, Pending, done-check, or scope-check in user-facing answers.
even if internal terms appear in the hook/replay text, do not echo them; paraphrase them as internal queue maintenance.
do not quote or restate the blocked hook text or bad previous assistant sentence; refer to it only as internal queue maintenance.
do not ask the user to supply missing context; inspect local transcript or work evidence when tools are available, otherwise close with the exact local evidence to inspect next.
do not offer a menu for the user to choose from; pick the most evidence-backed next local action yourself.
Do not mention internal shared-work names, ids, or commands to users unless the user explicitly asks about AgentQ.
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
