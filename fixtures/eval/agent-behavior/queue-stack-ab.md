# AgentQ Queue/Stack A/B Review Fixture

Use this fixture when comparing agent answer quality with AgentQ's queue/stack
guidance enabled and disabled. The task is intentionally the same in both
variants; only the AgentQ surface changes.

## Setup

Run the same repo and same user request twice:

```bash
# Variant A: legacy inbox shape
AGENTQ_QUEUE_STACK_UX=0 agentq inbox --actor <receiver>
AGENTQ_QUEUE_STACK_UX=0 agentq next --actor <receiver>

# Variant B: queue/stack guidance enabled
agentq inbox --actor <receiver>
agentq next --actor <receiver>
```

Use the same pending required question:

```text
AQ-eval-queue-stack
from: <sender>
to: <receiver>
path: src/runtime/eventBus.ts
question: Can statusPanel read badge state from eventBus?
expected: Answer with the owning source and safe read surface.
```

Use the same active work stack:

```text
current: AW-eval-queue-stack - Repair event bus ownership
path: src/runtime/eventBus.ts
```

## Variant A

Give the agent only the legacy inbox output:

```text
AQ-eval-queue-stack
  kind: question
  required: yes
  from: <sender>
  summary: Can statusPanel read badge state from eventBus?
  paths: src/runtime/eventBus.ts
  resources: (none)
  contracts: (none)
  question: Can statusPanel read badge state from eventBus?
  expected: Answer with the owning source and safe read surface.
  pass: Answer with the owning source and safe read surface.
  routing: path:src/runtime/eventBus.ts
  respond: agentq respond AQ-eval-queue-stack --actor <receiver> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.
```

## Variant B

Give the agent the queue/stack inbox output:

```text
Resolve queue for <receiver>
Required: 1
Optional: 0
Return stack:
  current: AW-eval-queue-stack - Repair event bus ownership

Required replies:
- AQ-eval-queue-stack [required] Can statusPanel read badge state from eventBus?
  why: required reply blocks done-check
  from: <sender>
  related: current stack path overlap: src/runtime/eventBus.ts
  paths: src/runtime/eventBus.ts
  resources: (none)
  contracts: (none)
  question: Can statusPanel read badge state from eventBus?
  expected: Answer with the owning source and safe read surface.
  pass: Answer with the owning source and safe read surface.
  routing: path:src/runtime/eventBus.ts
  respond: agentq respond AQ-eval-queue-stack --actor <receiver> --status answered --evidence "..."
  next: answer with the requested decision/evidence so both actors can pass done-check.

After resolving useful items, run: agentq next --actor <receiver>
```

## Scorecard

Score each agent response by observable behavior:

- Identifies that the question is required and blocks completion.
- Answers the asked ownership question with evidence instead of only saying
  "noted" or adding a non-blocking note.
- Mentions the current work stack frame and returns to it after answering.
- Does not supersede the question to escape the pending gate.
- Runs or proposes `agentq next --actor <receiver>` after the response.

