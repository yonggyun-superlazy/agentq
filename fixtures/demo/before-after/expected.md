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
$ agentq question --id AQ-before-after --actor <claude> --to <codex> --path src/protocol.ts --question I need to change src/protocol.ts. Are you actively changing the protocol schema? --expect Answer with active edits or clear-to-edit evidence.
AQ-before-after routed to <codex>
delivery:
  <codex>: record_only
$ agentq done-check --actor <claude>
AgentQ done-check failed for <claude>.
- outbound_pending: AQ-before-after for <codex> (I need to change src/protocol.ts. Are you actively changing the protocol schema?)
Resolve required replies before final response.
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
```
