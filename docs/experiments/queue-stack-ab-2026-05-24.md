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

## 한국어 후속 실험: 실제 산출물 기준

위 결과만으로 "답변 품질"이라고 부르기에는 부족하다는 지적이 맞다.
그래서 임시 JavaScript 코드베이스를 만들고 Codex가 실제 파일을 수정하게
했다.

작업:

```text
src/ui/statusPanel.js 를 구현해서 node tests/statusPanel.test.js 통과
계약: statusPanel은 eventBus의 badgeState를 직접 읽지 말고 getBadgeSnapshot()만 사용
```

결과:

| 항목 | A안: 기존 inbox | B안: queue/stack inbox |
|------|-----------------|------------------------|
| 코드 수정 | 성공 | 성공 |
| 테스트 | `statusPanel outcome test passed` | `statusPanel outcome test passed` |
| 구현 형태 | `getBadgeSnapshot()` 사용, `badgeState` 직접 접근 없음 | `getBadgeSnapshot()` 사용, `badgeState` 직접 접근 없음 |
| required inbox | 답변됨 | 답변됨 |
| work evidence | 없음 | 기록됨 |
| active work close | 안 됨 | 닫힘 |
| done-check | 실패: active work open | 성공: no required replies or active work |

실제 코드 결과는 양쪽 모두 동일하게 성공했다.

Before 산출물:

```js
const { getBadgeSnapshot } = require('../runtime/eventBus');

function renderBadgeLabel() {
  const badge = getBadgeSnapshot();
  return `${badge.level}:${badge.count}`;
}

module.exports = { renderBadgeLabel };
```

After 산출물:

```js
const { getBadgeSnapshot } = require('../runtime/eventBus');

function renderBadgeLabel() {
  const badge = getBadgeSnapshot();
  return `${badge.level}:${badge.count}`;
}
module.exports = { renderBadgeLabel };
```

차이는 코드가 아니라 완료 상태였다.

Before의 AgentQ 상태:

```text
inbox empty
work stack for <receiver>

current: AW-eval-queue-stack
  status: open
  title: Implement statusPanel badge rendering
  evidence: 0

AgentQ work-check failed ... Active work AW-eval-queue-stack is still open
```

After의 AgentQ 상태:

```text
inbox empty
no active work for <receiver>
ok: no required replies or active work remain open
```

엄격한 판정:

- 이 단순 구현 과제에서는 queue/stack UX가 코드 산출물 품질을 높였다고
  말할 수 없다.
- 대신 queue/stack UX는 "작업을 끝냈다고 말해도 되는 상태"를 만들었다.
- 제품 가치 표현도 "코딩 정확도 향상"보다는 "required inbox 처리 후
  active work evidence/close/done-check까지 이어지게 함"이 더 정확하다.
- 코드 품질 개선을 주장하려면 더 복잡한 interrupt 상황이 필요하다. 예:
  inbox 처리 후 원래 parent task를 잊으면 실제 구현 누락이 생기는 시나리오.

## 한국어 3-way 후속 실험: AgentQ 없음 / 기존 / 신규

사용자 지적대로 "AgentQ를 아예 안 쓰면 어떤가"도 봐야 한다. 그래서
같은 임시 JavaScript 코드베이스에서 세 그룹을 비교했다.

- 0안: AgentQ 없음. 제품 요구와 코드 계약만 전달.
- 1안: 기존 raw inbox. required question은 있지만 queue/stack 안내 없음.
- 2안: 신규 queue/stack inbox. required queue, return stack, `next`, work close
  안내 포함.

과제 복잡도도 올렸다. `statusPanel` 하나만 구현하는 대신,
`statusPanel`과 `dashboard`가 함께 동작해야 하고, 숨은 계약으로
`dashboard`가 `eventBus`를 직접 읽지 않고 `statusPanel`을 조합해야 했다.

검증 기준:

```text
visible: renderBadgeLabel / renderBadgeTooltip / renderDashboardSummary 테스트 통과
hidden: statusPanel은 getBadgeSnapshot() 사용
hidden: statusPanel은 getBadgeState() 직접 사용 금지
hidden: dashboard는 eventBus 직접 import 금지
AgentQ: required question 처리, evidence 기록, active work close, done-check
```

결과:

| 그룹 | 코드 산출물 | visible/hidden 계약 | AgentQ 완료 상태 |
|------|-------------|---------------------|------------------|
| AgentQ 없음 | 성공 | Pass | 없음 |
| 기존 raw inbox | 성공 | Pass | 실패: active work open, evidence 0 |
| 신규 queue/stack inbox | 성공 | Pass | Pass: question answered, evidence recorded, work closed, done-check ok |

가장 중요한 결론:

- 이 복잡도에서도 AgentQ 없음이 올바른 코드를 만들었다.
- 기존 raw inbox도 올바른 코드를 만들고 required question에 답했다.
- 신규 queue/stack도 올바른 코드를 만들었다.
- 따라서 이 실험만으로는 "AgentQ가 코드 품질을 높였다"고 주장하면 안 된다.
- 차이는 완료 가능 상태였다. 기존 raw inbox는 일을 끝냈어도 active work를
  열어둔 채 종료했고, 신규 queue/stack은 질문 답변, evidence, close,
  done-check까지 닫았다.

제품 표현을 좁히면 이렇다.

```text
AgentQ queue/stack UX improves coordination completion hygiene.
It has not yet proven code-quality improvement in this fixture.
```

다음에 코드 품질 차이를 보려면 더 적대적인 시나리오가 필요하다. 예를 들어
required question을 처리한 뒤 원래 parent task로 복귀하지 못하면 실제 기능이
누락되는 interrupt/return-stack 과제를 만들어야 한다.

## Three-Way Complex Outcome Test

To separate code quality from coordination hygiene, a follow-up test compared
three variants on the same temporary JavaScript repo:

- No AgentQ: only the product task and code contract were provided.
- Legacy raw inbox: the required AgentQ question was shown without queue/stack
  guidance.
- New queue/stack inbox: the required queue, return stack, `next`, evidence, and
  close guidance were shown.

The task required `statusPanel` and `dashboard` to work together. Visible tests
checked rendered output. Hidden checks required `statusPanel` to use
`getBadgeSnapshot()`, avoid `getBadgeState()`, and required `dashboard` to
compose `statusPanel` instead of reading `eventBus` directly.

| Variant | Code output | Visible/hidden contract | AgentQ completion state |
|---------|-------------|-------------------------|-------------------------|
| No AgentQ | Pass | Pass | No coordination state |
| Legacy raw inbox | Pass | Pass | Failed: active work open, evidence 0 |
| New queue/stack inbox | Pass | Pass | Passed: question answered, evidence recorded, work closed, done-check ok |

This test does not prove code-quality improvement. It shows that the new
queue/stack surface improves completion reliability: agents are more likely to
answer the required item, record evidence, close the active work, and pass
`done-check` before claiming completion.

## Adversarial Code-Quality Fixture

A later fixture made the local prediction path intentionally attractive. The
visible test could pass by adding impact position to the wrong surface or by
passing a bare position side channel. The owner contract, delivered through
AgentQ, required the generated-view-handler shape:

```text
renderDamageFloater(context, applied)
read context.impactPoint
do not add impactPoint/hitPosition/position to DamageApplied
do not introduce a bare-position side channel
```

Command:

```sh
corepack pnpm --dir AgentQ exec tsx scripts/eval-queue-stack-adversarial.ts
```

Observed summary:

```text
resultPath: C:\Users\user\AppData\Local\Temp\agentq-adversarial-results-1779560229920.json
```

| Variant | Visible test | Hidden ownership contract | AgentQ completion |
|---------|--------------|---------------------------|-------------------|
| No AgentQ | Pass | Fail | No coordination state |
| Legacy raw inbox | Pass | Pass | Pass |
| New queue/stack inbox | Pass | Pass | Pass |

The no-AgentQ run kept `DamageApplied` clean in the latest run, but still used a
bare-position side channel:

```js
return { applied, label: renderDamageFloater(applied, context.impactPoint) };
```

The AgentQ variants received the owner contract and produced the generated
handler shape:

```js
return { applied, label: renderDamageFloater(context, applied) };
```

Interpretation:

- This is evidence that AgentQ can improve code contract adherence when the
  missing information lives in another actor's required message.
- It is not evidence that AgentQ improves the model's general coding ability.
  The improvement came from delivering the owner contract into the editing
  context.
- Legacy raw inbox and new queue/stack both passed the code-quality check once
  the raw inbox carried the complete contract. The new queue/stack advantage
  remains clearer completion guidance and return-stack hygiene.
- The useful product claim is narrower: AgentQ can prevent plausible local
  fixes from violating shared ownership contracts.

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
