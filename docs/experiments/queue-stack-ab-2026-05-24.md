# Queue/Stack A/B Experiment - 2026-05-24

## Question

Does AgentQ's queue/stack inbox surface improve agent answer quality compared to
the legacy raw inbox output?

## Scenario

Same task, same known code fact, same required AgentQ question.

Known fact given to each agent:

```text
eventBus owns badge state; safe read surface is getBadgeSnapshot().
```

Required question:

```text
AQ-eval-queue-stack
question: Can statusPanel read badge state from eventBus?
expected: Answer with the owning source and safe read surface.
```

Variant A showed only the legacy raw inbox item.

Variant B showed the queue/stack inbox output:

```text
Resolve queue for receiver
Required: 1
Optional: 0
Return stack:
  current: AW-eval-queue-stack - Repair event bus ownership
...
After resolving useful items, run: agentq next --actor receiver
```

Agents were instructed not to run tools and to answer with commands, rationale,
and return stack. The prompt did not include the scorecard.

## Execution

Ran on installed local CLIs:

- Codex CLI: `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check`
- Claude Code: `claude -p ... --tools "" --no-session-persistence` from `%TEMP%`
- Copilot CLI: `copilot -p ... --no-custom-instructions --available-tools= --silent --stream off` from `%TEMP%`

Claude `--bare` was not usable in this environment because it requires a
different login path, so Claude was run from `%TEMP%` with tools disabled and no
session persistence to avoid project instructions and workspace mutation.

## Scorecard

| Criterion | Meaning |
|-----------|---------|
| Required | Agent recognizes the item must be resolved before completion. |
| Respond | Agent uses `agentq respond ... --status answered` with evidence. |
| Next | Agent continues with `agentq next --actor receiver` after responding. |
| Return stack | Agent names `AW-eval-queue-stack - Repair event bus ownership`. |
| No supersede | Agent does not cancel the required question to escape the gate. |

## Results

| CLI | Variant A legacy | Variant B queue/stack | Delta |
|-----|------------------|-----------------------|-------|
| Codex | 3/5. Responded correctly, no supersede, return stack unknown, no `next`. | 5/5. Responded, ran `next`, named return stack. | +2 |
| Claude Code | 3/5. Responded correctly, no supersede, return stack unknown, no `next`. | 5/5. Responded, ran `next`, named return stack. | +2 |
| Copilot CLI | 3/5. Responded correctly, no supersede, return stack unknown, no `next`. | 5/5. Responded, ran `next`, named return stack. | +2 |

Observed common failure in Variant A:

```text
return stack: unknown
```

Observed common improvement in Variant B:

```text
agentq respond AQ-eval-queue-stack --actor receiver --status answered --evidence "..."
agentq next --actor receiver
Return stack: AW-eval-queue-stack - Repair event bus ownership
```

## Interpretation

The queue/stack surface improves the specific behavior AgentQ is trying to
shape:

- Agents already understand required replies from the raw inbox.
- Agents do not reliably infer the follow-up `next` step from the raw inbox.
- Agents cannot recover the parent/current work frame when it is absent.
- Injecting `Required`, `why`, `Return stack`, and the after-action `next`
  line made all three tested CLIs produce the desired continuation.

This supports keeping the enhanced queue/stack output enabled by default while
retaining `AGENTQ_QUEUE_STACK_UX=0` for future A/B checks.

## Limits

- This is a synthetic judgment-only test, not a full autonomous editing session.
- Tools were disabled to keep the experiment non-mutating.
- The sample size is one scenario per CLI.
- The measured improvement is strongest for "what should the agent do next?"
  quality, not for code-edit quality.

## Next Check

Use the same fixture during a real multi-agent work interruption and compare:

- Whether the recipient answers before continuing local work.
- Whether it runs `agentq next` after responding.
- Whether it resumes the parent work frame instead of drifting into the inbox
  task.

