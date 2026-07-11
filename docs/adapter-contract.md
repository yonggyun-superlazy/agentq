# Adapter contract

AgentQ's first-party adapters translate a small set of client hook payloads into
registration and read-only coordination lookups. They do not authorize, reject, or
rewrite an edit.

## Common identity

Both adapters bind these values together:

- adapter id: `codex` or `claude`
- native session id: the payload's `session_id`
- workspace identity: the payload's `cwd`

A lookup succeeds only for the same adapter, native session, and workspace that were
registered. Missing or changed identity produces a quiet unavailable result.

The payload examples below use synthetic session and workspace placeholders. A real
payload must supply the client's native session id and an absolute workspace path.

## Session start

Both adapters accept startup and resume payloads:

```json
{
  "hook_event_name": "SessionStart",
  "source": "startup",
  "session_id": "session-a",
  "cwd": "<workspace-a-root>"
}
```

The adapter ensures the OS-local, workspace-scoped store exists and registers the
session. Other session-start sources are ignored.

## Codex structured edits

Codex lookup runs only for `PreToolUse` plus `tool_name: "apply_patch"`:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session-a",
  "cwd": "<workspace-a-root>",
  "tool_name": "apply_patch",
  "tool_input": {
    "command": "*** Begin Patch\n*** Update File: src/api/client.ts\n@@\n-old\n+new\n*** End Patch"
  }
}
```

Targets come only from a complete patch envelope with valid `Add File`, `Update File`,
`Delete File`, and optional `Move to` headers. Malformed or unsupported patch input
produces no targets and is ignored; the adapter does not infer paths from surrounding
text.

## Claude structured edits

Claude lookup runs only for `PreToolUse` plus `tool_name: "Edit"` or
`tool_name: "Write"`:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session-a",
  "cwd": "<workspace-a-root>",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "<workspace-a-root>/src/api/client.ts"
  }
}
```

`file_path` must be an absolute native path. Relative, empty, and missing paths are
ignored.

## Results

Every adapter result exits with code `0`. The ordinary result is fully quiet:

```json
{
  "code": 0,
  "stdout": "",
  "stderr": "",
  "diagnostics": []
}
```

Invalid input, unavailable registration, missing session bindings, and lookup failures
also stay quiet at the client boundary. Their internal diagnostic codes are returned to
programmatic adapter callers but are not printed by the CLI hook runner.

When a supported edit overlaps another actor's declared claim, stdout contains only:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Another active session has a declared claim overlapping this file."
  }
}
```

When the current actor has a pending required question, that question takes precedence
and `additionalContext` begins with:

```text
A required coordination question is pending for this session:
```

All other hook events and tools are ignored. The adapters provide context only; they do
not block the client operation.
