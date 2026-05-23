$ agentq enter --as codex --session dd-setup-owner --paths ProjectDD/Data --resource setup-watcher:ProjectDD/DDSetup --responsibility DD setup watcher and generated data validation

<owner> registered

$ agentq enter --as claude-code --session dd-test-caller --paths ProjectDD/DDUnityTestHost/Assets/Tests --responsibility DD Unity test coverage

<caller> registered

$ agentq owners --actor <caller> --resource setup-watcher:ProjectDD/DDSetup

owners for resource:setup-watcher:ProjectDD/DDSetup:
  <owner> | owns-resource: setup-watcher:ProjectDD/DDSetup | matched: setup-watcher:projectdd/ddsetup | responsibilities: DD setup watcher and generated data validation

Use a required question when this may affect the owner:
  Ownership is a routing signal, not a lock. Ask the owner to classify overlap; do not wait silently from presence alone.
  agentq question --actor <your-actor-id> --to <owner> --resource setup-watcher:projectdd/ddsetup --question "<decision needed>" --expect "<answer with evidence>"
  Use `agentq note ...` instead when this is review/context and your completion should not wait for a reply.

$ agentq question --id AQ-resource-demo --actor <caller> --resource setup-watcher:ProjectDD/DDSetup --question I need to run DD setup validation. Are you currently holding the DD setup watcher? --expect Answer with active setup constraints or clear-to-run evidence.

AQ-resource-demo routed to <owner>
delivery:
  <owner>: record_only
next: run `agentq done-check --actor <your-actor-id>` before finishing; answered evidence will be shown there once resolved.

$ agentq done-check --actor <caller>

AgentQ done-check failed for <caller>.
- outbound_pending: AQ-resource-demo for <owner> (I need to run DD setup validation. Are you currently holding the DD setup watcher?)
  next: wait for <owner> to respond; rerun agentq done-check --actor <caller> to see answered evidence.
Resolve required replies before final response.

$ agentq inbox --actor <owner>

AQ-resource-demo
  kind: question
  required: yes
  from: <caller>
  summary: I need to run DD setup validation. Are you currently holding the DD setup watcher?
  paths: (none)
  resources: setup-watcher:ProjectDD/DDSetup
  contracts: (none)
  question: I need to run DD setup validation. Are you currently holding the DD setup watcher?
  expected: Answer with active setup constraints or clear-to-run evidence.
  pass: Answer with active setup constraints or clear-to-run evidence.
  routing: resource:setup-watcher:ProjectDD/DDSetup
  respond: agentq respond AQ-resource-demo --actor <owner> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.

$ agentq respond AQ-resource-demo --actor <owner> --status answered --evidence DD setup watcher is idle; safe to run validation now.

AQ-resource-demo answered

$ agentq done-check --actor <caller>

ok: no required replies or active work remain open

Resolved outbound replies:
  AQ-resource-demo answered by <owner>
    summary: I need to run DD setup validation. Are you currently holding the DD setup watcher?
    evidence: DD setup watcher is idle; safe to run validation now.

next: use the answered evidence above before continuing; keep using --actor <caller> for AgentQ commands.
