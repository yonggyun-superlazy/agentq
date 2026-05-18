# AgentQ Hook Fixture Sources

Checked on 2026-05-18.

- Codex: https://developers.openai.com/codex/hooks
  - Project-local hooks are discovered from `<repo>/.codex/hooks.json`.
  - `SessionStart` can add developer context.
  - `Stop` accepts JSON `{ "decision": "block", "reason": "..." }` and continues the turn.
- Claude Code: https://code.claude.com/docs/en/hooks
  - Project hooks live in `.claude/settings.json`.
  - Command hooks receive JSON on stdin.
  - `Stop` supports top-level `decision: "block"`; exit code `2` is also blocking.
- GitHub Copilot: https://docs.github.com/en/copilot/reference/hooks-reference
  - Repository hooks live in `.github/hooks/*.json`.
  - `sessionStart` can inject `additionalContext`.
  - `agentStop` accepts `{ "decision": "block", "reason": "..." }` and forces another turn.
