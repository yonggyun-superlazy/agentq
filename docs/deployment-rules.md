# Project-local deployment rules

`agentq install`, `agentq uninstall`, and `agentq doctor` operate on the current project
root. They do not edit profile-level instructions or configuration.

## Dry-run first

Both mutation commands default to dry-run. Dry-run reports the selected adapters and
the files that would be created, updated, or deleted without writing them:

```text
agentq install --dry-run
agentq install --adapter codex --dry-run
agentq install --adapter claude --dry-run
agentq uninstall --dry-run
```

`--adapter all` is the default. `--dry-run` and `--yes` are mutually exclusive.

## Install

Apply the inspected plan explicitly:

```text
agentq install --yes
agentq install --adapter codex --yes
agentq install --adapter claude --yes
```

The installer writes only the selected project's integration files:

| Adapter | Project files | Events and matchers |
| --- | --- | --- |
| Codex | `.codex/config.toml`, `.codex/hooks.json` | `SessionStart` for `startup|resume`; `PreToolUse` for `apply_patch` |
| Claude | `.claude/settings.json` | `SessionStart` for `startup|resume`; `PreToolUse` for `Edit|Write` |

Hook commands use quoted absolute executable and entrypoint paths. Existing unrelated
hook entries and configuration keys are preserved. If the Codex project configuration
explicitly disables hooks, installation stops with a diagnostic instead of overriding
that choice.

## Uninstall

Inspect and then remove only entries that exactly match AgentQ's installed command and
matcher shapes:

```text
agentq uninstall --dry-run
agentq uninstall --yes
```

Unrelated hook entries and configuration keys remain. An empty hook JSON file is
removed. The Codex feature file is removed only when its complete contents are the
minimal AgentQ-created feature configuration; otherwise it is preserved.

## Doctor

`doctor` is read-only:

```text
agentq doctor
```

It reports missing, matching, mismatched, or invalid project hook entries; the Codex
project feature state; and client-side trust checks that cannot be proven from project
files alone. A successful file check does not prove that a running client loaded or
trusted the configuration.
