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
Refresh this exact actor before claiming done: agentq enter --actor <target> --paths <owned-path> [--resource <resource>] --responsibility "<owned contract>"
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
$ agentq owners --actor <target> --path src/protocol.ts
owners for src/protocol.ts:
  <owner> | owns: src/protocol.ts | matched: src/protocol.ts | responsibilities: protocol schema

Use a required question when this may affect the owner:
  agentq question --actor <your-actor-id> --to <owner> --path src/protocol.ts --question "<decision needed>" --expect "<answer with evidence>"
$ agentq question --id AQ-instruction-path --actor <target> --path src/protocol.ts --question I need to update the protocol consumer. What protocol fields must I preserve? --expect Answer with active protocol edits or clear-to-edit evidence.
AQ-instruction-path routed to <owner>
delivery:
  <owner>: record_only
$ agentq done-check --actor <target>
AgentQ done-check failed for <target>.
- outbound_pending: AQ-instruction-path for <owner> (I need to update the protocol consumer. What protocol fields must I preserve?)
Resolve required replies before final response.
$ agentq inbox --actor <owner>
AQ-instruction-path
  kind: question
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
$ agentq respond AQ-instruction-path --actor <owner> --status answered --evidence Preserve routingEvidence and keep RequiredRequest routing evidence visible.
AQ-instruction-path answered
$ agentq work evidence --actor <target> --evidence Owner answered protocol field contract; consumer update can preserve routingEvidence.
evidence: AW-instruction-quality
  actor: <target>
  status: open
  title: Modify protocol consumer safely
  touched: src/consumer.ts
  evidence: 1
$ agentq work close --actor <target> --summary Protocol consumer update is unblocked by owner evidence.
closed: AW-instruction-quality
  actor: <target>
  status: closed
  title: Modify protocol consumer safely
  touched: src/consumer.ts
  evidence: 1
  summary: Protocol consumer update is unblocked by owner evidence.
$ agentq done-check --actor <target>
ok: no required replies or active work remain open
```
