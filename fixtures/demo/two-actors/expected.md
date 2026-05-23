# Two-Actor Handshake Demo

```text
$ agentq enter --as codex --session codex-demo --paths packages/core/src/** --responsibility protocol schema

<codex> registered

$ agentq enter --as claude-code --session claude-demo --paths README.md --responsibility public docs

<claude> registered

$ agentq block --id AQ-0001 --actor <codex> --to <claude> --path README.md --summary README promises config that protocol forbids

AQ-0001 routed to <claude>
delivery:
  <claude>: record_only

$ agentq inbox --actor <claude>

AQ-0001
  kind: blocker
  from: <codex>
  summary: README promises config that protocol forbids
  paths: README.md
  resources: (none)
  contracts: (none)
  observed: README promises config that protocol forbids
  broken: required handoff must be answered
  pass: recipient responds
  routing: explicit:explicit recipient <claude>
  respond: agentq respond AQ-0001 --actor <claude> --status resolved --evidence "..."

$ agentq respond AQ-0001 --actor <claude> --status resolved --evidence README now says no config and no repo .agentq

AQ-0001 resolved

$ agentq done-check --actor <codex>

ok: no required replies or active work remain open
```
