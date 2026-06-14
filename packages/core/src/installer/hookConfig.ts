import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type HookConfigAction = "create" | "update" | "unchanged" | "remove" | "delete" | "missing";
export type HookAdapterTarget = "codex" | "claude-code" | "copilot-cli";

export interface HookConfigEntry {
  readonly adapter: HookAdapterTarget;
  readonly label: string;
  readonly relativePath: string;
  readonly action: HookConfigAction;
  readonly beforeExists: boolean;
}

export interface HookConfigPlan {
  readonly entries: readonly HookConfigEntry[];
}

interface HookTarget {
  readonly adapter: HookAdapterTarget;
  readonly label: string;
  readonly relativePath: string;
  readonly buildInstalledConfig: (existing: JsonObject | undefined, workspaceRoot: string) => JsonObject;
  readonly removeInstalledConfig: (existing: JsonObject | undefined) => JsonObject | null;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const AGENTQ_COMMAND_PREFIX = "agentq hook ";
const CODEX_PRE_TOOL_MATCHER = "apply_patch|shell_command|multi_tool_use.parallel|Edit|MultiEdit|Write";
const CLAUDE_CODE_PRE_TOOL_MATCHER = "Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit";
const AGENTQ_HOOK_EVENTS = ["session-start", "pre-tool", "stop"] as const;

function agentQHookCommand(adapter: HookAdapterTarget, event: (typeof AGENTQ_HOOK_EVENTS)[number], workspaceRoot: string): string {
  if (adapter !== "copilot-cli") {
    const directNode = windowsDirectNodeCommand(workspaceRoot);
    if (directNode !== undefined) {
      return `${directNode} hook ${adapter} ${event}`;
    }
  }

  return `agentq hook ${adapter} ${event}`;
}

function windowsDirectNodeCommand(workspaceRoot: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const entrypoint = resolveAgentQMainEntrypoint(workspaceRoot);
  if (entrypoint === undefined) {
    return undefined;
  }

  const nodeExe = process.env.AGENTQ_INSTALL_NODE_EXE ?? process.execPath;
  return `${quoteCommandArg(nodeExe)} ${quoteCommandArg(entrypoint)}`;
}

function resolveAgentQMainEntrypoint(workspaceRoot: string): string | undefined {
  const override = process.env.AGENTQ_INSTALL_AGENTQ_MAIN;
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }

  const workspaceEntrypoint = path.join(workspaceRoot, "AgentQ", "packages", "cli", "dist", "main.js");
  if (existsSync(workspaceEntrypoint)) {
    return workspaceEntrypoint;
  }

  const currentEntrypoint = process.argv[1];
  if (currentEntrypoint !== undefined && isAgentQEntrypoint(currentEntrypoint)) {
    return currentEntrypoint;
  }

  const appData = process.env.APPDATA;
  if (appData !== undefined && appData.trim().length > 0) {
    const npmEntrypoint = path.join(appData, "npm", "node_modules", "agentq", "dist", "main.js");
    if (existsSync(npmEntrypoint)) {
      return npmEntrypoint;
    }
  }

  return undefined;
}

function isAgentQEntrypoint(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith("/agentq/dist/main.js") ||
    normalized.endsWith("/agentq/packages/cli/dist/main.js") ||
    normalized.endsWith("/agentq/packages/cli/src/main.ts")
  );
}

function quoteCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

const HOOK_TARGETS: readonly HookTarget[] = [
  {
    adapter: "codex",
    label: "Codex SessionStart/PreToolUse/Stop hook gate",
    relativePath: ".codex/hooks.json",
    buildInstalledConfig: (existing, workspaceRoot) =>
      upsertNestedHookConfig(existing, [
        {
          event: "SessionStart",
          group: {
            matcher: "startup|resume|clear",
            hooks: [
              {
                type: "command",
                command: agentQHookCommand("codex", "session-start", workspaceRoot),
                statusMessage: "Registering AgentQ session",
                timeout: 10
              }
            ]
          }
        },
        {
          event: "PreToolUse",
          group: {
            matcher: CODEX_PRE_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: agentQHookCommand("codex", "pre-tool", workspaceRoot),
                statusMessage: "Updating AgentQ active scope",
                timeout: 10
              }
            ]
          }
        },
        {
          event: "Stop",
          group: {
            hooks: [
              {
                type: "command",
                command: agentQHookCommand("codex", "stop", workspaceRoot),
                statusMessage: "Checking AgentQ required replies",
                timeout: 10
              }
            ]
          }
        }
      ]),
    removeInstalledConfig: (existing) => removeNestedHookConfig(existing, "codex")
  },
  {
    adapter: "claude-code",
    label: "Claude Code SessionStart/PreToolUse/Stop hook gate",
    relativePath: ".claude/settings.json",
    buildInstalledConfig: (existing, workspaceRoot) =>
      upsertNestedHookConfig(existing, [
        {
          event: "SessionStart",
          group: {
            matcher: "startup|resume|clear|compact",
            hooks: [
              {
                type: "command",
                command: agentQHookCommand("claude-code", "session-start", workspaceRoot),
                statusMessage: "Registering AgentQ session",
                timeout: 10
              }
            ]
          }
        },
        {
          event: "PreToolUse",
          group: {
            matcher: CLAUDE_CODE_PRE_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: agentQHookCommand("claude-code", "pre-tool", workspaceRoot),
                statusMessage: "Updating AgentQ active scope",
                timeout: 10
              }
            ]
          }
        },
        {
          event: "Stop",
          group: {
            hooks: [
              {
                type: "command",
                command: agentQHookCommand("claude-code", "stop", workspaceRoot),
                statusMessage: "Checking AgentQ required replies",
                timeout: 10
              }
            ]
          }
        }
      ]),
    removeInstalledConfig: (existing) => removeNestedHookConfig(existing, "claude-code")
  },
  {
    adapter: "copilot-cli",
    label: "Copilot sessionStart/preToolUse/agentStop hook gate",
    relativePath: ".github/hooks/agentq.json",
    buildInstalledConfig: (existing) =>
      upsertFlatHookConfig(existing, {
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: "command",
              command: "agentq hook copilot-cli session-start",
              timeoutSec: 10
            }
          ],
          preToolUse: [
            {
              type: "command",
              command: "agentq hook copilot-cli pre-tool",
              timeoutSec: 10
            }
          ],
          agentStop: [
            {
              type: "command",
              command: "agentq hook copilot-cli stop",
              timeoutSec: 10
            }
          ]
        }
      }),
    removeInstalledConfig: (existing) => removeFlatHookConfig(existing, "copilot-cli")
  }
];

export async function planHookConfigInstall(workspaceRoot: string): Promise<HookConfigPlan> {
  return await planHookConfigMutation(workspaceRoot, "install");
}

export async function applyHookConfigInstall(workspaceRoot: string): Promise<HookConfigPlan> {
  const plan = await planHookConfigInstall(workspaceRoot);
  await applyHookConfigMutation(workspaceRoot, "install", plan.entries);
  return plan;
}

export async function planHookConfigUninstall(workspaceRoot: string): Promise<HookConfigPlan> {
  return await planHookConfigMutation(workspaceRoot, "uninstall");
}

export async function applyHookConfigUninstall(workspaceRoot: string): Promise<HookConfigPlan> {
  const plan = await planHookConfigUninstall(workspaceRoot);
  await applyHookConfigMutation(workspaceRoot, "uninstall", plan.entries);
  return plan;
}

async function planHookConfigMutation(
  workspaceRoot: string,
  mode: "install" | "uninstall"
): Promise<HookConfigPlan> {
  const entries: HookConfigEntry[] = [];

  for (const target of HOOK_TARGETS) {
    const filePath = path.join(workspaceRoot, target.relativePath);
    const beforeText = await readOptionalText(filePath);
    const beforeConfig = beforeText === undefined ? undefined : parseJsonObject(beforeText, target.relativePath);
    const afterConfig =
      mode === "install"
        ? target.buildInstalledConfig(beforeConfig, workspaceRoot)
        : target.removeInstalledConfig(beforeConfig);
    const beforeSerialized = beforeConfig === undefined ? undefined : serializeJson(beforeConfig);
    const afterSerialized = afterConfig === null ? undefined : serializeJson(afterConfig);
    const action = decideAction(mode, beforeSerialized, afterSerialized);

    entries.push({
      adapter: target.adapter,
      label: target.label,
      relativePath: target.relativePath,
      action,
      beforeExists: beforeText !== undefined
    });
  }

  return { entries };
}

async function applyHookConfigMutation(
  workspaceRoot: string,
  mode: "install" | "uninstall",
  entries: readonly HookConfigEntry[]
): Promise<void> {
  const targetByPath = new Map(HOOK_TARGETS.map((target) => [target.relativePath, target]));

  for (const entry of entries) {
    if (entry.action === "unchanged" || entry.action === "missing") {
      continue;
    }

    const target = targetByPath.get(entry.relativePath);
    if (target === undefined) {
      throw new Error(`No hook target registered for ${entry.relativePath}`);
    }

    const filePath = path.join(workspaceRoot, entry.relativePath);
    if (entry.action === "delete") {
      await rm(filePath);
      continue;
    }

    const beforeText = await readOptionalText(filePath);
    const beforeConfig = beforeText === undefined ? undefined : parseJsonObject(beforeText, entry.relativePath);
    const afterConfig =
      mode === "install"
        ? target.buildInstalledConfig(beforeConfig, workspaceRoot)
        : target.removeInstalledConfig(beforeConfig);

    if (afterConfig === null) {
      await rm(filePath);
      continue;
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeJson(afterConfig), "utf8");
  }
}

function upsertNestedHookConfig(
  existing: JsonObject | undefined,
  additions: readonly { readonly event: string; readonly group: JsonObject }[]
): JsonObject {
  const root = cloneObject(existing ?? {});
  const hooks = ensureObject(root, "hooks");
  const adapter = commandAdapterFromAdditions(additions);

  for (const addition of additions) {
    const currentEventGroups = ensureArray(hooks, addition.event);
    if (containsExpectedNestedHookEntries(currentEventGroups, addition.group)) {
      hooks[addition.event] = currentEventGroups;
      continue;
    }

    const eventGroups = currentEventGroups
      .map((group) => removeNestedAgentQHookGroupEntries(group, adapter))
      .filter(isDefined);
    eventGroups.push(cloneValue(addition.group));
    hooks[addition.event] = eventGroups;
  }

  return root;
}

function removeNestedHookConfig(
  existing: JsonObject | undefined,
  adapter: HookAdapterTarget
): JsonObject | null {
  if (existing === undefined) {
    return null;
  }

  const root = cloneObject(existing);
  const hooks = asObject(root.hooks);
  if (hooks === undefined) {
    return root;
  }

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }

    const remaining = value.map((group) => removeNestedAgentQHookGroupEntries(group, adapter)).filter(isDefined);
    if (remaining.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = remaining;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  }

  return Object.keys(root).length === 0 ? null : root;
}

function removeNestedAgentQHookGroupEntries(value: JsonValue, adapter: HookAdapterTarget): JsonValue | undefined {
  if (!containsAgentQCommand(value, adapter)) {
    return cloneValue(value);
  }

  const group = asObject(value);
  if (group === undefined || !Array.isArray(group.hooks)) {
    return undefined;
  }

  const remainingHooks = group.hooks.filter((hook) => !containsAgentQCommand(hook, adapter));
  if (remainingHooks.length === 0) {
    return undefined;
  }

  const next = cloneObject(group);
  next.hooks = cloneValue(remainingHooks);
  return next;
}

function containsExpectedNestedHookEntries(groups: readonly JsonValue[], expectedGroup: JsonObject): boolean {
  if (!Array.isArray(expectedGroup.hooks)) {
    throw new Error("Expected nested AgentQ hook group hooks to be an array.");
  }

  const expectedHooks = expectedGroup.hooks;
  return groups.some((group) => {
    const groupObject = asObject(group);
    const hooks = groupObject?.hooks;
    return (
      groupObject !== undefined &&
      Array.isArray(hooks) &&
      nestedHookGroupMetadataMatches(groupObject, expectedGroup) &&
      expectedHooks.every((expectedHook) => hooks.some((hook) => jsonValueEquals(hook, expectedHook)))
    );
  });
}

function nestedHookGroupMetadataMatches(group: JsonObject, expectedGroup: JsonObject): boolean {
  return Object.entries(expectedGroup)
    .filter(([key]) => key !== "hooks")
    .every(([key, expectedValue]) => jsonValueEquals(group[key] as JsonValue, expectedValue));
}

function upsertFlatHookConfig(existing: JsonObject | undefined, addition: JsonObject): JsonObject {
  const root = cloneObject(existing ?? {});
  const hooks = ensureObject(root, "hooks");
  const additionHooks = asObject(addition.hooks);
  if (additionHooks === undefined) {
    throw new Error("AgentQ Copilot hook template is missing hooks.");
  }

  root.version = 1;
  for (const [event, value] of Object.entries(additionHooks)) {
    const currentEntries = ensureArray(hooks, event).filter(
      (entry) => !containsAgentQCommand(entry, "copilot-cli")
    );
    hooks[event] = [...currentEntries, ...cloneArray(value)];
  }

  return root;
}

function removeFlatHookConfig(existing: JsonObject | undefined, adapter: HookAdapterTarget): JsonObject | null {
  if (existing === undefined) {
    return null;
  }

  const root = cloneObject(existing);
  const hooks = asObject(root.hooks);
  if (hooks === undefined) {
    return root;
  }

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }

    const remaining = value.filter((entry) => !containsAgentQCommand(entry, adapter));
    if (remaining.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = remaining;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  }

  return Object.keys(root).length === 0 || onlyVersionRemains(root) ? null : root;
}

function containsAgentQCommand(value: JsonValue, adapter: HookAdapterTarget): boolean {
  if (typeof value === "string") {
    return containsAgentQHookCommand(value, adapter);
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsAgentQCommand(item, adapter));
  }

  const object = asObject(value);
  if (object === undefined) {
    return false;
  }

  return Object.values(object).some((item) => containsAgentQCommand(item, adapter));
}

function containsAgentQHookCommand(value: string, adapter: HookAdapterTarget): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  const lowerAdapter = adapter.toLowerCase();
  const eventPattern = AGENTQ_HOOK_EVENTS.map(escapeRegex).join("|");
  const hookPattern = new RegExp(`\\bhook\\s+${escapeRegex(lowerAdapter)}\\s+(?:${eventPattern})\\b`);
  if (!hookPattern.test(normalized)) {
    return false;
  }

  return (
    normalized.includes(`${AGENTQ_COMMAND_PREFIX}${lowerAdapter} `) ||
    normalized.includes("/agentq/dist/main.js") ||
    normalized.includes("/agentq/packages/cli/dist/main.js") ||
    normalized.includes("/agentq/packages/cli/src/main.ts")
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandAdapterFromAdditions(
  additions: readonly { readonly group: JsonObject }[]
): HookAdapterTarget {
  const serialized = JSON.stringify(additions).replace(/\\/g, "/").toLowerCase();
  if (serialized.includes(" hook codex ")) {
    return "codex";
  }

  if (serialized.includes(" hook claude-code ")) {
    return "claude-code";
  }

  return "copilot-cli";
}

function decideAction(
  mode: "install" | "uninstall",
  beforeSerialized: string | undefined,
  afterSerialized: string | undefined
): HookConfigAction {
  if (mode === "install") {
    if (beforeSerialized === undefined) {
      return "create";
    }

    return beforeSerialized === afterSerialized ? "unchanged" : "update";
  }

  if (beforeSerialized === undefined) {
    return "missing";
  }

  if (afterSerialized === undefined) {
    return "delete";
  }

  return beforeSerialized === afterSerialized ? "missing" : "remove";
}

function ensureObject(root: JsonObject, key: string): JsonObject {
  const existing = root[key];
  if (existing === undefined) {
    const value: JsonObject = {};
    root[key] = value;
    return value;
  }

  const object = asObject(existing);
  if (object === undefined) {
    throw new Error(`Expected JSON object at ${key}`);
  }

  return object;
}

function ensureArray(root: JsonObject, key: string): JsonValue[] {
  const existing = root[key];
  if (existing === undefined) {
    return [];
  }

  if (!Array.isArray(existing)) {
    throw new Error(`Expected JSON array at hooks.${key}`);
  }

  return [...existing];
}

function cloneObject(value: JsonObject): JsonObject {
  return cloneValue(value) as JsonObject;
}

function cloneArray(value: JsonValue): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected JSON array.");
  }

  return cloneValue(value) as JsonValue[];
}

function cloneValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function jsonValueEquals(left: JsonValue, right: JsonValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValueEquals(item, right[index] as JsonValue))
    );
  }

  const leftObject = asObject(left);
  const rightObject = asObject(right);
  if (leftObject !== undefined || rightObject !== undefined) {
    if (leftObject === undefined || rightObject === undefined) {
      return false;
    }

    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && jsonValueEquals(leftObject[key] as JsonValue, rightObject[key] as JsonValue))
    );
  }

  return left === right;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value;
}

function parseJsonObject(content: string, relativePath: string): JsonObject {
  const parsed = JSON.parse(content) as JsonValue;
  const object = asObject(parsed);
  if (object === undefined) {
    throw new Error(`Expected ${relativePath} to contain a JSON object.`);
  }

  return object;
}

function serializeJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function onlyVersionRemains(root: JsonObject): boolean {
  return Object.keys(root).length === 1 && root.version === 1;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
