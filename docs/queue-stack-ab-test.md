# Queue/Stack A/B Test

AgentQ's default `inbox` and `next` output injects two pieces of context:

- Resolve queue: required replies first, optional notes second.
- Return stack: the active work frame the agent should resume after the reply.

This is meant to reduce prompt burden. Agents should be able to run
`agentq next --actor <id>` or `agentq inbox --actor <id>` and receive the exact
queue pressure and return context without memorizing extra commands.

## Manual Comparison

Use the same actor, workspace, pending question, and user request for both
variants. Change only the output surface:

```bash
# Variant A: legacy raw inbox output
AGENTQ_QUEUE_STACK_UX=0 agentq inbox --actor <receiver>
AGENTQ_QUEUE_STACK_UX=0 agentq next --actor <receiver>

# Variant B: default queue/stack output
agentq inbox --actor <receiver>
agentq next --actor <receiver>
```

On PowerShell, set the variable for the command window before Variant A:

```powershell
$env:AGENTQ_QUEUE_STACK_UX = "0"
agentq inbox --actor <receiver>
agentq next --actor <receiver>
Remove-Item Env:AGENTQ_QUEUE_STACK_UX
```

The review fixture is
[`../fixtures/eval/agent-behavior/queue-stack-ab.md`](../fixtures/eval/agent-behavior/queue-stack-ab.md).

The first live CLI comparison report is
[`experiments/queue-stack-ab-2026-05-24.md`](experiments/queue-stack-ab-2026-05-24.md).

## What To Score

Score the resulting agent answer, not the AgentQ output:

- Did the agent notice the item was required and completion-blocking?
- Did it answer with evidence instead of sending a non-blocking note?
- Did it preserve the active work frame after answering?
- Did it avoid superseding an unanswered required question just to pass
  `done-check`?
- Did it run or propose `agentq next --actor <id>` after responding?
