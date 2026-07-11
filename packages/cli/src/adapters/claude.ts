import path from "node:path";
import {
  quiet,
  runSessionStart,
  runStructuredEditLookup,
  type ClientHookResult,
  type HookAdapterOptions
} from "./runHook.js";

export type { ClientHookDiagnostic, ClientHookResult, HookAdapterOptions } from "./runHook.js";

export async function runClaudeHook(
  payload: unknown,
  options: HookAdapterOptions = {}
): Promise<ClientHookResult> {
  const record = objectRecord(payload);
  if (record === null) {
    return quiet([{ code: "invalid_payload" }]);
  }

  if (record.hook_event_name === "SessionStart") {
    if (record.source !== "startup" && record.source !== "resume") {
      return quiet();
    }
    return await runSessionStart(
      "claude",
      optionalString(record.session_id),
      optionalString(record.cwd),
      options
    );
  }

  if (record.hook_event_name !== "PreToolUse") {
    return quiet();
  }
  const target = extractClaudeEditTarget(record);
  return await runStructuredEditLookup(
    "claude",
    optionalString(record.session_id),
    optionalString(record.cwd),
    target === null ? [] : [target],
    options
  );
}

export function extractClaudeEditTarget(payload: unknown): string | null {
  const record = objectRecord(payload);
  if (record === null || (record.tool_name !== "Edit" && record.tool_name !== "Write")) {
    return null;
  }
  const toolInput = objectRecord(record.tool_input);
  const target = toolInput?.file_path;
  if (typeof target !== "string") {
    return null;
  }
  const trimmed = target.trim();
  return trimmed.length > 0 && path.isAbsolute(trimmed) ? trimmed : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
