import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type FirstPartyAdapter = "codex" | "claude";

export interface HookConfigMutationInput {
  readonly workspaceRoot: string;
  readonly adapters: readonly FirstPartyAdapter[];
  readonly handlerCommand: string;
  readonly mutate: boolean;
}

export interface HookConfigMutationResult {
  readonly mode: "dry-run" | "applied";
  readonly adapters: readonly FirstPartyAdapter[];
  readonly changes: readonly HookConfigChange[];
}

export interface HookConfigChange {
  readonly path: string;
  readonly action: "create" | "update" | "delete";
}

interface PlannedFileChange extends HookConfigChange {
  readonly next: string | null;
}

export class HookConfigError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export async function installProjectHooks(
  input: HookConfigMutationInput
): Promise<HookConfigMutationResult> {
  assertAbsoluteHandler(input.handlerCommand);
  const changes: PlannedFileChange[] = [];
  for (const adapter of input.adapters) {
    if (adapter === "codex") {
      const featurePath = path.join(input.workspaceRoot, ".codex", "config.toml");
      const previousFeature = await readOptional(featurePath);
      planText(changes, featurePath, previousFeature, enableCodexHooks(previousFeature));
    }
    const filePath = adapterConfigPath(input.workspaceRoot, adapter);
    const previous = await readOptional(filePath);
    const root = parseJsonObject(previous, filePath);
    addOwnedEntries(root, adapter, input.handlerCommand, filePath);
    planText(changes, filePath, previous, renderJson(root));
  }
  if (input.mutate) {
    await applyChanges(changes);
  }
  return publicResult(input, changes);
}

export async function uninstallProjectHooks(
  input: HookConfigMutationInput
): Promise<HookConfigMutationResult> {
  assertAbsoluteHandler(input.handlerCommand);
  const changes: PlannedFileChange[] = [];
  for (const adapter of input.adapters) {
    const filePath = adapterConfigPath(input.workspaceRoot, adapter);
    const previous = await readOptional(filePath);
    if (previous !== null) {
      const root = parseJsonObject(previous, filePath);
      removeOwnedEntries(root, adapter, input.handlerCommand, filePath);
      const next = Object.keys(root).length === 0 ? null : renderJson(root);
      planText(changes, filePath, previous, next);
    }
    if (adapter === "codex") {
      const featurePath = path.join(input.workspaceRoot, ".codex", "config.toml");
      const previousFeature = await readOptional(featurePath);
      if (previousFeature === canonicalCodexFeatureFile()) {
        planText(changes, featurePath, previousFeature, null);
      }
    }
  }
  if (input.mutate) {
    await applyChanges(changes);
  }
  return publicResult(input, changes);
}

export function expectedHookEntry(
  adapter: FirstPartyAdapter,
  event: "SessionStart" | "PreToolUse",
  handlerCommand: string
): Record<string, unknown> {
  const eventName = event === "SessionStart" ? "session-start" : "pre-tool-use";
  const command = `${handlerCommand} hook ${adapter} ${eventName}`;
  const hook = {
    type: "command",
    command,
    ...(adapter === "codex"
      ? {
          commandWindows: codexWindowsCommand(handlerCommand, ["hook", adapter, eventName])
        }
      : {})
  };
  return {
    matcher:
      event === "SessionStart"
        ? "startup|resume"
        : adapter === "codex"
          ? "apply_patch"
          : "Edit|Write",
    hooks: [hook]
  };
}

export function adapterConfigPath(
  workspaceRoot: string,
  adapter: FirstPartyAdapter
): string {
  return adapter === "codex"
    ? path.join(workspaceRoot, ".codex", "hooks.json")
    : path.join(workspaceRoot, ".claude", "settings.json");
}

export function hasExpectedEntries(
  root: Record<string, unknown>,
  adapter: FirstPartyAdapter,
  handlerCommand: string
): boolean {
  const hooks = objectValue(root.hooks);
  if (hooks === null) {
    return false;
  }
  return (["SessionStart", "PreToolUse"] as const).every((event) => {
    const entries = hooks[event];
    return Array.isArray(entries) && entries.some((entry) => deepEqual(
      entry,
      expectedHookEntry(adapter, event, handlerCommand)
    ));
  });
}

export function inspectCodexFeatureSource(
  source: string | null
): "missing" | "enabled" | "disabled" | "invalid" {
  if (source === null) {
    return "missing";
  }
  try {
    const root = parseTomlObject(source);
    const features = root.features;
    if (features === undefined) {
      return "missing";
    }
    const featureTable = objectValue(features);
    if (featureTable === null) {
      return "invalid";
    }
    const hooks = featureTable.hooks;
    return hooks === undefined
      ? "missing"
      : hooks === true
        ? "enabled"
        : hooks === false
          ? "disabled"
          : "invalid";
  } catch {
    return "invalid";
  }
}

export async function readJsonConfig(
  filePath: string
): Promise<Record<string, unknown> | null> {
  const source = await readOptional(filePath);
  return source === null ? null : parseJsonObject(source, filePath);
}

export async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function addOwnedEntries(
  root: Record<string, unknown>,
  adapter: FirstPartyAdapter,
  handlerCommand: string,
  filePath: string
): void {
  const hooks = ensureObjectProperty(root, "hooks", filePath);
  for (const event of ["SessionStart", "PreToolUse"] as const) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new HookConfigError("invalid_hook_config", `${filePath}: hooks.${event} must be an array`);
    }
    const entries = (existing ?? []) as unknown[];
    const owned = expectedHookEntry(adapter, event, handlerCommand);
    const legacy = legacyCodexHookEntry(adapter, event, handlerCommand);
    const hasOwned = entries.some((entry) => deepEqual(entry, owned));
    let replacedLegacy = false;
    const next = entries.flatMap((entry) => {
      if (legacy !== null && deepEqual(entry, legacy)) {
        if (!hasOwned && !replacedLegacy) {
          replacedLegacy = true;
          return [owned];
        }
        return [];
      }
      return [entry];
    });
    hooks[event] = hasOwned || replacedLegacy ? next : [...next, owned];
  }
}

function removeOwnedEntries(
  root: Record<string, unknown>,
  adapter: FirstPartyAdapter,
  handlerCommand: string,
  filePath: string
): void {
  const hooks = objectValue(root.hooks);
  if (root.hooks !== undefined && hooks === null) {
    throw new HookConfigError("invalid_hook_config", `${filePath}: hooks must be an object`);
  }
  if (hooks === null) {
    return;
  }
  for (const event of ["SessionStart", "PreToolUse"] as const) {
    const existing = hooks[event];
    if (existing === undefined) {
      continue;
    }
    if (!Array.isArray(existing)) {
      throw new HookConfigError("invalid_hook_config", `${filePath}: hooks.${event} must be an array`);
    }
    const owned = expectedHookEntry(adapter, event, handlerCommand);
    const legacy = legacyCodexHookEntry(adapter, event, handlerCommand);
    const remaining = existing.filter(
      (entry) => !deepEqual(entry, owned) && (legacy === null || !deepEqual(entry, legacy))
    );
    if (remaining.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = remaining;
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  }
}

function enableCodexHooks(source: string | null): string {
  if (source === null) {
    return canonicalCodexFeatureFile();
  }
  const root = parseTomlObject(source);
  const existingFeatures = root.features;
  const features = existingFeatures === undefined ? {} : objectValue(existingFeatures);
  if (features === null) {
    throw new HookConfigError("invalid_codex_config", "features must be a TOML table");
  }
  if (features.hooks === false) {
    throw new HookConfigError(
      "codex_hooks_disabled",
      "project .codex/config.toml explicitly disables hooks"
    );
  }
  if (features.hooks === true) {
    return source;
  }
  if (features.hooks !== undefined) {
    throw new HookConfigError("invalid_codex_config", "features.hooks must be boolean");
  }
  features.hooks = true;
  root.features = features;
  const rendered = stringifyToml(root);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function canonicalCodexFeatureFile(): string {
  return "[features]\nhooks = true\n";
}

function parseTomlObject(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch (error) {
    throw new HookConfigError("invalid_codex_config", errorText(error));
  }
  const root = objectValue(parsed);
  if (root === null) {
    throw new HookConfigError("invalid_codex_config", "TOML root must be a table");
  }
  return root;
}

function parseJsonObject(source: string | null, filePath: string): Record<string, unknown> {
  if (source === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new HookConfigError("invalid_hook_config", `${filePath}: ${errorText(error)}`);
  }
  const root = objectValue(parsed);
  if (root === null) {
    throw new HookConfigError("invalid_hook_config", `${filePath}: root must be an object`);
  }
  return root;
}

function ensureObjectProperty(
  root: Record<string, unknown>,
  key: string,
  filePath: string
): Record<string, unknown> {
  if (root[key] === undefined) {
    const created: Record<string, unknown> = {};
    root[key] = created;
    return created;
  }
  const value = objectValue(root[key]);
  if (value === null) {
    throw new HookConfigError("invalid_hook_config", `${filePath}: ${key} must be an object`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renderJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function planText(
  changes: PlannedFileChange[],
  filePath: string,
  previous: string | null,
  next: string | null
): void {
  if (previous === next) {
    return;
  }
  changes.push({
    path: filePath,
    action: next === null ? "delete" : previous === null ? "create" : "update",
    next
  });
}

async function applyChanges(changes: readonly PlannedFileChange[]): Promise<void> {
  for (const change of changes) {
    if (change.next === null) {
      await rm(change.path, { force: true });
    } else {
      await writeAtomic(change.path, change.next);
    }
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function publicResult(
  input: HookConfigMutationInput,
  changes: readonly PlannedFileChange[]
): HookConfigMutationResult {
  return {
    mode: input.mutate ? "applied" : "dry-run",
    adapters: [...input.adapters],
    changes: changes.map(({ path: filePath, action }) => ({ path: filePath, action }))
  };
}

function assertAbsoluteHandler(handlerCommand: string): void {
  if (!/^"[A-Za-z]:\\/.test(handlerCommand) && !/^"\//.test(handlerCommand)) {
    throw new HookConfigError(
      "invalid_handler_command",
      "handler command must begin with a quoted absolute executable"
    );
  }
}

function legacyCodexHookEntry(
  adapter: FirstPartyAdapter,
  event: "SessionStart" | "PreToolUse",
  handlerCommand: string
): Record<string, unknown> | null {
  if (adapter !== "codex") {
    return null;
  }
  const command = `${handlerCommand} hook codex ${event === "SessionStart" ? "session-start" : "pre-tool-use"}`;
  return {
    matcher: event === "SessionStart" ? "startup|resume" : "apply_patch",
    hooks: [{ type: "command", command, commandWindows: command }]
  };
}

function codexWindowsCommand(
  handlerCommand: string,
  hookArguments: readonly string[]
): string {
  const invocation = [...parseHandlerCommand(handlerCommand), ...hookArguments]
    .map(powerShellLiteral)
    .join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `& ${invocation}`,
    "$hookSucceeded = $?",
    "$hookExitCode = $LASTEXITCODE",
    "if ($null -ne $hookExitCode) { exit $hookExitCode }",
    "if ($hookSucceeded) { exit 0 }",
    "exit 1"
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function parseHandlerCommand(handlerCommand: string): readonly string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < handlerCommand.length) {
    while (handlerCommand[index] === " ") {
      index += 1;
    }
    if (handlerCommand[index] !== '"') {
      throw new HookConfigError(
        "invalid_handler_command",
        "handler command parts must be double-quoted"
      );
    }
    index += 1;
    let part = "";
    let closed = false;
    while (index < handlerCommand.length) {
      const current = handlerCommand[index];
      if (current === '"') {
        index += 1;
        closed = true;
        break;
      }
      if (current === "\\" && handlerCommand[index + 1] === '"') {
        part += '"';
        index += 2;
        continue;
      }
      part += current;
      index += 1;
    }
    if (!closed || (index < handlerCommand.length && handlerCommand[index] !== " ")) {
      throw new HookConfigError(
        "invalid_handler_command",
        "handler command contains an invalid quoted part"
      );
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new HookConfigError("invalid_handler_command", "handler command is empty");
  }
  return parts;
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (leftObject === null || rightObject === null) {
    return false;
  }
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(leftObject[key], rightObject[key])
    )
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
