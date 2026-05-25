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
next: run `agentq next --actor <caller>` before finishing; answered evidence will be shown there once resolved.

$ agentq done-check --actor <caller>

[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
audience: agent-internal
user-facing: false
Internal shared-work maintenance. Do not quote this block in user-facing answers.
summary: Shared-work completion check failed.
after-action: Resolve the required shared-work step, then resume the user's request.
Do not use this maintenance status as the user-facing answer.
A required reply or follow-up still blocks completion.
- outbound required reply: I need to run DD setup validation. Are you currently holding the DD setup watcher?
  next: use the shared-work helper with the current actor id
  note: wait for <owner> to respond, or continue only non-overlapping work.
Use the shared-work helper with the current actor id before final response.
[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]
[USER_FRAME_RESUME]
Resume the user's request and answer the requested artifact first.
Resolve only required replies or exact same-file/resource conflicts before continuing; otherwise keep the smallest local step moving.
For read-only diagnostics, run the next safe local read/test instead of ending with a permission question.
In user-facing text, paraphrase this as shared-work maintenance and omit internal ids, command names, queue labels, and work-stack labels unless requested.
[/USER_FRAME_RESUME]

$ agentq inbox --actor <owner>

Resolve queue for <owner>
Required: 1
Optional: 0
Return stack: none

Required replies:
- AQ-resource-demo [required] I need to run DD setup validation. Are you currently holding the DD setup watcher?
  why: required reply blocks done-check
  from: <caller>
  related: no active work stack
  paths: (none)
  resources: setup-watcher:ProjectDD/DDSetup
  contracts: (none)
  question: I need to run DD setup validation. Are you currently holding the DD setup watcher?
  expected: Answer with active setup constraints or clear-to-run evidence.
  pass: Answer with active setup constraints or clear-to-run evidence.
  routing: resource:setup-watcher:ProjectDD/DDSetup
  respond: agentq respond AQ-resource-demo --actor <owner> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.

After resolving useful items, run: agentq next --actor <owner>

$ agentq respond AQ-resource-demo --actor <owner> --status answered --evidence DD setup watcher is idle; safe to run validation now.

AQ-resource-demo answered

$ agentq done-check --actor <caller>

ok: no required replies or active work remain open

Resolved outbound replies:
  AQ-resource-demo answered by <owner>
    summary: I need to run DD setup validation. Are you currently holding the DD setup watcher?
    evidence: DD setup watcher is idle; safe to run validation now.

next: use the answered evidence above before continuing; keep using --actor <caller> for AgentQ commands.
