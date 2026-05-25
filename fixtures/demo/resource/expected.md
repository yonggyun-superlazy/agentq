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
Internal queue maintenance only. Do not include this status or these commands in the user-facing answer.
summary: AgentQ done-check failed for <caller>.
after-action: Resolve the required shared-work step, then return to the user's original request and answer the requested artifact first.
Do not use this block reason as the user-facing answer.
AgentQ done-check failed for <caller>.
- outbound_pending: AQ-resource-demo for <owner> (I need to run DD setup validation. Are you currently holding the DD setup watcher?)
  next: agentq next --actor <caller>
  note: wait for <owner> to respond, or continue only non-overlapping work.
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
