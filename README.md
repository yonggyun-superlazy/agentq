# AgentQ

AgentQ is a local coordination primitive for coding-agent sessions sharing one workspace.

It keeps local actor and session state, records explicit path/resource/contract claims,
finds overlapping owners, and carries required questions between registered sessions.
The first-party Codex and Claude adapters register sessions and perform quiet, read-only
lookups before supported structured edits.

## Core workflow

Registration returns the actor identifier used by later commands:

```text
agentq register --adapter adapter-a --session session-a
agentq claims set --actor <actor-a> --path src/api --resource build-cache
agentq owners --actor <actor-b> --path src/api/client.ts
```

The required-question protocol has five operations:

```text
agentq question --actor <actor-b> --to <actor-a> --path src/api/client.ts --question "May I update this contract?"
agentq answer <question-a> --actor <actor-a> --answer "Yes; preserve the response shape."
agentq not_mine <question-a> --actor <actor-a>
agentq cancel <question-a> --actor <actor-b>
agentq inbox --actor <actor-a>
```

`answer`, `not_mine`, and `cancel` are alternative terminal actions for a pending
question. The examples above use synthetic identifiers; use the identifiers returned
by your own registration and question commands.

## Client adapters

- Session start and resume events register the exact native session and workspace.
- Supported structured-edit events perform owner and pending-question lookups only.
- Ordinary success and unavailable-state paths are silent and exit successfully.
- An overlap or pending question adds short context to the current edit event.

The adapter input and result shapes are documented in
[`docs/adapter-contract.md`](docs/adapter-contract.md).

## Project-local setup

Inspect changes first, then opt in from the project root:

```text
agentq install --dry-run
agentq install --yes
agentq doctor
```

Installation is limited to the selected project's Codex and Claude hook configuration.
See [`docs/deployment-rules.md`](docs/deployment-rules.md) for the exact files,
ownership rules, and uninstall flow.

## Explicit limits

- AgentQ does not block file mutation.
- AgentQ does not enforce leases, expiration, or stale-session policy.
- AgentQ does not cover shell commands or arbitrary child processes.
- AgentQ does not negotiate conflicts or reassign work autonomously.
- AgentQ does not claim to improve a model's general coding quality or performance.
- Coordination state is local to one machine and one workspace identity.

AgentQ supplies evidence and a narrow question channel. The participating agents and
their users remain responsible for deciding whether and how work proceeds.

## Development

The workspace uses pnpm:

```text
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm package:smoke
```

## License

MIT
