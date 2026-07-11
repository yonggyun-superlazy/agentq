import {
  quiet,
  runSessionStart,
  runStructuredEditLookup,
  type ClientHookResult,
  type HookAdapterOptions
} from "./runHook.js";

export type { ClientHookDiagnostic, ClientHookResult, HookAdapterOptions } from "./runHook.js";

export async function runCodexHook(
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
      "codex",
      optionalString(record.session_id),
      optionalString(record.cwd),
      options
    );
  }

  if (record.hook_event_name !== "PreToolUse" || record.tool_name !== "apply_patch") {
    return quiet();
  }
  const toolInput = objectRecord(record.tool_input);
  const command = toolInput === null ? undefined : toolInput.command;
  if (typeof command !== "string") {
    return quiet();
  }
  const targets = extractCodexPatchTargets(command);
  return await runStructuredEditLookup(
    "codex",
    optionalString(record.session_id),
    optionalString(record.cwd),
    targets,
    options
  );
}

export function extractCodexPatchTargets(source: string): readonly string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    return [];
  }

  const targets: string[] = [];
  const seen = new Set<string>();
  let currentOperation: "add" | "update" | "delete" | null = null;
  let moveAllowed = false;
  let moved = false;
  let sawAddLine = false;
  let sawUpdateHunk = false;
  for (const line of lines.slice(1, -1)) {
    const operation = /^(?:\*\*\* )(Add|Update|Delete) File: (.+)$/.exec(line);
    if (operation !== null) {
      if (!isCompleteOperation(currentOperation, moved, sawAddLine, sawUpdateHunk)) {
        return [];
      }
      const kind = operation[1]?.toLowerCase();
      const target = validHeaderPath(operation[2]);
      if (
        target === null ||
        (kind !== "add" && kind !== "update" && kind !== "delete") ||
        seen.has(target)
      ) {
        return [];
      }
      targets.push(target);
      seen.add(target);
      currentOperation = kind;
      moveAllowed = kind === "update";
      moved = false;
      sawAddLine = false;
      sawUpdateHunk = false;
      continue;
    }

    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move !== null) {
      const target = validHeaderPath(move[1]);
      if (!moveAllowed || currentOperation !== "update" || target === null || seen.has(target)) {
        return [];
      }
      targets.push(target);
      seen.add(target);
      moveAllowed = false;
      moved = true;
      continue;
    }

    if (line === "*** End of File") {
      if (currentOperation !== "update" || !sawUpdateHunk) {
        return [];
      }
      moveAllowed = false;
      continue;
    }
    if (line.startsWith("***")) {
      return [];
    }
    moveAllowed = false;
    if (currentOperation === "add") {
      if (!line.startsWith("+")) {
        return [];
      }
      sawAddLine = true;
      continue;
    }
    if (currentOperation === "update") {
      if (line.startsWith("@@")) {
        sawUpdateHunk = true;
        continue;
      }
      if (!sawUpdateHunk || !/^[ +\-]/.test(line)) {
        return [];
      }
      continue;
    }
    return [];
  }

  return targets.length === 0 || !isCompleteOperation(currentOperation, moved, sawAddLine, sawUpdateHunk)
    ? []
    : targets;
}

function isCompleteOperation(
  operation: "add" | "update" | "delete" | null,
  moved: boolean,
  sawAddLine: boolean,
  sawUpdateHunk: boolean
): boolean {
  return operation === null || operation === "delete" || (operation === "add" && sawAddLine) || moved || sawUpdateHunk;
}

function validHeaderPath(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("\0") ||
    trimmed.startsWith("***")
  ) {
    return null;
  }
  return trimmed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
