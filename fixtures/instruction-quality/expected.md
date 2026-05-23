# AgentQ Instruction Quality Transcript

```text
$ agentq enter --as codex --session protocol-owner --paths src/protocol.ts --responsibility protocol schema
<owner> registered
$ agentq enter --as copilot-cli --session instruction-target --paths . --responsibility copilot session
<target> registered
$ agentq scope-check --actor <target>
AgentQ scope-check failed for <target>.
- broad_path: .
- generic_responsibility: copilot session
Run: agentq next --actor <target>
It will print the exact scope refresh command for this actor.
$ agentq enter --actor <target> --paths src/consumer.ts --responsibility protocol consumer change --summary Modify protocol consumer safely
<target> refreshed
$ agentq inbox --actor <target>
inbox empty
$ agentq work status --actor <target>
no active work for <target>
$ agentq work start --id AW-instruction-quality --actor <target> --title Modify protocol consumer safely --path src/consumer.ts
started: AW-instruction-quality
  actor: <target>
  status: open
  title: Modify protocol consumer safely
  touched: src/consumer.ts
  evidence: 0
  next: record collaboration context now: agentq work evidence --actor <target> --evidence "Context: current frame; observed basis; touched paths/resources; next pass check"
$ agentq work evidence --actor <target> --evidence Context: current frame is protocol consumer update; observed owner on src/protocol.ts; touched path src/consumer.ts; next pass check is owner answer on fields to preserve.
evidence: AW-instruction-quality
  actor: <target>
  status: open
  title: Modify protocol consumer safely
  touched: src/consumer.ts
  evidence: 1
  next: add missing final evidence or close with summary when the frame is actually done
$ agentq owners --actor <target> --path src/protocol.ts
owners for src/protocol.ts:
  <owner> | owns: src/protocol.ts | matched: src/protocol.ts | responsibilities: protocol schema

Use a required question when this may affect the owner:
  Ownership is a routing signal, not a lock. Ask the owner to classify overlap; do not wait silently from presence alone.
  agentq question --actor <your-actor-id> --to <owner> --path src/protocol.ts --question "<decision needed>" --expect "<answer with evidence>"
  Use `agentq note ...` instead when this is review/context and your completion should not wait for a reply.
$ agentq question --id AQ-instruction-path --actor <target> --path src/protocol.ts --question I need to update the protocol consumer. What protocol fields must I preserve? --expect Answer with active protocol edits or clear-to-edit evidence.
AQ-instruction-path routed to <owner>
delivery:
  <owner>: record_only
next: run `agentq next --actor <target>` before finishing; answered evidence will be shown there once resolved.
$ agentq done-check --actor <target>
AgentQ done-check failed for <target>.
- outbound_pending: AQ-instruction-path for <owner> (I need to update the protocol consumer. What protocol fields must I preserve?)
  next: agentq next --actor <target>
  note: wait for <owner> to respond, or continue only non-overlapping work.
Follow `agentq next` before final response.
$ agentq inbox --actor <owner>
AQ-instruction-path
  kind: question
  required: yes
  from: <target>
  summary: I need to update the protocol consumer. What protocol fields must I preserve?
  paths: src/protocol.ts
  resources: (none)
  contracts: (none)
  question: I need to update the protocol consumer. What protocol fields must I preserve?
  expected: Answer with active protocol edits or clear-to-edit evidence.
  pass: Answer with active protocol edits or clear-to-edit evidence.
  routing: path:src/protocol.ts
  respond: agentq respond AQ-instruction-path --actor <owner> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.
$ agentq respond AQ-instruction-path --actor <owner> --status answered --evidence Preserve routingEvidence and keep RequiredRequest routing evidence visible.
AQ-instruction-path answered
$ agentq work evidence --actor <target> --evidence Owner answered protocol field contract; consumer update can preserve routingEvidence.
evidence: AW-instruction-quality
  actor: <target>
  status: open
  title: Modify protocol consumer safely
  touched: src/consumer.ts
  evidence: 2
  next: add missing final evidence or close with summary when the frame is actually done
$ agentq work close --actor <target> --summary Protocol consumer update is unblocked by owner evidence.
closed: AW-instruction-quality
  actor: <target>
  status: closed
  title: Modify protocol consumer safely
  touched: src/consumer.ts
  evidence: 2
  summary: Protocol consumer update is unblocked by owner evidence.
$ agentq done-check --actor <target>
ok: no required replies or active work remain open

Resolved outbound replies:
  AQ-instruction-path answered by <owner>
    summary: I need to update the protocol consumer. What protocol fields must I preserve?
    evidence: Preserve routingEvidence and keep RequiredRequest routing evidence visible.

next: use the answered evidence above before continuing; keep using --actor <target> for AgentQ commands.
```
