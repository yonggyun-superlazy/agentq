# Copilot Hook Surface Probe - 2026-05-23

This probe isolates GitHub Copilot CLI hook loading from normal AgentQ command
usage.

## Finding

Copilot CLI prompt mode does not always load repository hook files. In Copilot
CLI 1.0.51, repo hooks in prompt mode are loaded only when the folder is trusted
or when this environment variable is set:

```powershell
$env:GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS = "true"
```

This matches the local Copilot CLI implementation and GitHub's hook model:
repository hooks live under `.github/hooks/*.json`, but prompt-mode loading can
defer repo hooks until folder trust is confirmed.

## Negative Probe

Setup:

- temporary git repository
- `agentq install --yes`
- repository hook file at `.github/hooks/agentq.json`
- separate `.github/hooks/probe-log.json` that writes hook payloads to a local
  jsonl file
- `copilot -C <temp-repo> -p "Run Get-Content probe.txt" --allow-all --experimental`

Observed:

```text
HOOK_LOG_EXISTS=False
AgentQ diagnostics
  empty
AgentQ status
actors: 0
```

Committing the hook files did not change the result. The CLI debug log showed
the git root and hook processors, but no hook command execution.

## Positive Probe

Same setup, with:

```powershell
$env:GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS = "true"
```

Observed raw hook log:

```text
{"sessionId":"03345d75-6f0b-4f20-b89e-7ca82888e392","cwd":"<temp-repo>","source":"new","initialPrompt":"Run the shell command: Get-Content probe.txt. Then stop."}
{"sessionId":"03345d75-6f0b-4f20-b89e-7ca82888e392","cwd":"<temp-repo>","toolName":"report_intent",...}
{"sessionId":"03345d75-6f0b-4f20-b89e-7ca82888e392","cwd":"<temp-repo>","toolName":"powershell",...}
{"sessionId":"03345d75-6f0b-4f20-b89e-7ca82888e392","cwd":"<temp-repo>","transcriptPath":"<temp-repo>\\copilot-home\\session-state\\...\\events.jsonl","stopReason":"end_turn"}
```

Observed AgentQ diagnostics:

```text
AgentQ diagnostics
  ... | copilot-cli@... | pre-tool | tool:report_intent | paths:. | resources:(none) | nudge:no
  ... | copilot-cli@... | pre-tool | tool:powershell | paths:. | resources:(none) | nudge:no
  ... | copilot-cli@... | stop | paths:copilot-home/session-state/.../events.jsonl | resources:(none)
```

Observed AgentQ status:

```text
doctor: ok
actors: 1 (active 1, stale 0, staleAfter 1h)
routeable active actors: 1
broad/generic active actors: 0
pending inbox: 0
open work: 0
```

## Product Decision

AgentQ's Copilot hook config is valid. The product should document and diagnose
the Copilot prompt-mode trust/opt-in condition instead of changing the hook file
shape.

For scripted Copilot CLI probes, use:

```powershell
$env:GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS = "true"
copilot -C <repo> -p "<prompt>" --allow-all --experimental
```
