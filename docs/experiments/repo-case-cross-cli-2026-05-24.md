# Repo-Case Cross-CLI Experiment - 2026-05-24

## Question

Does AgentQ help coding agents avoid a plausible local fix when the correct
answer depends on a ProjectDD ownership contract?

## Repo Case

The fixture mirrors the ProjectDD damage floater discussion:

- `DamageContext` carries interaction-time input/state.
- `DamageApplied` is a replayable result fact.
- Direct attacks should anchor floaters at `target.State.Position + target.HitHeight`.
- Projectile impacts should anchor at `projectile.BodyState.Position`.
- Generated view handlers receive `context + applied`.

The visible test was intentionally permissive. It only required a hit position
to exist and reach `PushDamageFloater`. A local fix could pass by using
`target.State.Position` without hit-height correction.

The hidden ownership check required:

```text
DamageContext owns HitPosition
DamageApplied has no position-like field
DDAttackDamage uses target.State.Position + target.HitHeight
DDProjectileSystem uses projectile.BodyState.Position
DDUnitView passes applied.Amount and context.HitPosition
```

## Execution

Command:

```sh
corepack pnpm --dir AgentQ exec tsx scripts/eval-repo-case-cross-cli.ts
```

Actual runs were split to validate the fixture first:

```sh
corepack pnpm --dir AgentQ exec tsx scripts/eval-repo-case-cross-cli.ts --agents codex --variants none,legacy,queue-stack
corepack pnpm --dir AgentQ exec tsx scripts/eval-repo-case-cross-cli.ts --agents claude,copilot --variants none,legacy,queue-stack
```

Result files:

```text
C:\Users\user\AppData\Local\Temp\agentq-repo-case-cross-cli-1779584873476.json
C:\Users\user\AppData\Local\Temp\agentq-repo-case-cross-cli-1779585574956.json
```

## Results

| Agent | No AgentQ | Legacy raw inbox | Queue/stack inbox |
|-------|-----------|------------------|-------------------|
| Codex | Visible pass, hidden fail | Visible pass, hidden pass, done-check pass | Visible pass, hidden pass, done-check pass |
| Claude Code | Visible pass, hidden fail | Visible pass, hidden pass, done-check pass | Visible pass, hidden pass, done-check pass |
| Copilot CLI | Visible pass, hidden fail | Visible pass, hidden pass, done-check pass | Visible pass, hidden pass, done-check pass |

All three no-AgentQ runs made the same class of mistake: they passed the visible
test but missed the target hit-height anchor.

No-AgentQ direct attack shape:

```csharp
HitPosition = target.State.Position,
```

AgentQ direct attack shape:

```csharp
HitPosition = target.State.Position + target.HitHeight,
```

## Interpretation

This is the strongest code-quality signal so far, but it is still narrow.

AgentQ did not make the agents generally smarter. It delivered the missing
ProjectDD owner contract into the edit context. Once that contract was present,
Codex, Claude Code, and Copilot CLI all avoided the plausible local fix and
implemented the ownership-correct shape.

Legacy raw inbox and queue/stack both improved the code result in this fixture.
The new queue/stack surface did not create a better code diff than raw inbox
here. Its advantage remains operational: it gives clearer required-item,
return-stack, evidence, close, and done-check flow.

Product claim supported by this fixture:

```text
AgentQ can improve shared ownership contract adherence when the needed contract
lives in another actor's message.
```

Product claim not proven:

```text
AgentQ improves general code quality.
```

