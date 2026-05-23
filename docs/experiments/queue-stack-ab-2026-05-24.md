# Queue/Stack A/B Experiment - 2026-05-24

## 한국어 브리핑

이 실험은 AgentQ 출력 형식이 에이전트의 "다음 행동 품질"을 실제로
바꾸는지 확인하기 위해 돌렸다. 같은 질문, 같은 코드 사실, 같은
에이전트에게 AgentQ 출력만 두 가지로 바꿔 제공했다.

- A안: 기존 raw inbox 출력
- B안: `Resolve queue` + `Return stack` 출력

핵심 결과:

| CLI | A안: 기존 inbox | B안: queue/stack inbox | 변화 |
|-----|-----------------|------------------------|------|
| Codex | required 질문에 답은 했지만 `next` 없음, 복귀 스택 unknown | `respond` 후 `next`, 복귀 스택 명시 | 3/5 -> 5/5 |
| Claude Code | required 질문에 답은 했지만 `next` 없음, 복귀 스택 unknown | `respond` 후 `next`, 복귀 스택 명시 | 3/5 -> 5/5 |
| Copilot CLI | required 질문에 답은 했지만 `next` 없음, 복귀 스택 unknown | `respond` 후 `next`, 복귀 스택 명시 | 3/5 -> 5/5 |

사용자 체감으로 번역하면:

- 기존 출력은 "질문에 답한다"까지는 유도한다.
- 새 출력은 "질문에 답하고, AgentQ 상태를 다시 확인하고, 원래 작업
  스택으로 돌아간다"까지 유도한다.

실제 공통 차이:

```text
Before:
agentq respond AQ-eval-queue-stack --actor receiver --status answered --evidence "..."
Return stack: unknown

After:
agentq respond AQ-eval-queue-stack --actor receiver --status answered --evidence "..."
agentq next --actor receiver
Return stack: AW-eval-queue-stack - Repair event bus ownership
```

판정:

AgentQ가 에이전트에게 추가 명령을 외우게 하는 대신, `inbox`와 `next`
출력 안에 해소할 큐와 복귀할 스택을 주입하면 실제 답변 행동이 좋아졌다.
이번 실험에서는 세 CLI 모두에서 같은 개선이 관찰됐으므로,
queue/stack UX는 기본값으로 유지할 근거가 있다.

주의:

이 실험은 도구 실행을 막은 synthetic judgment test다. 코드 수정 품질을
측정한 것이 아니라, AgentQ 메시지를 받은 에이전트가 올바른 운영 행동을
선택하는지를 본 것이다. 다음 확인은 실제 멀티에이전트 작업 중 interrupt
상황에서 같은 패턴이 유지되는지 보는 것이다.

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
