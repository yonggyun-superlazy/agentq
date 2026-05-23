import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { AGENTQ_MARKER_BEGIN, DEFAULT_MARKER_TARGETS } from "./markerBlock.js";
import { resolveWorkspaceStore, type WorkspaceStoreOptions } from "../store/workspaceStore.js";

export type DoctorLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly level: DoctorLevel;
  readonly name: string;
  readonly detail: string;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly workspaceRoot: string;
  readonly storePath: string;
  readonly summary: DoctorLevel;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const HOOK_TARGETS = [
  {
    adapter: "codex",
    relativePath: ".codex/hooks.json",
    name: "Codex hook gate",
    commands: [
      "agentq hook codex session-start",
      "agentq hook codex pre-tool",
      "agentq hook codex stop"
    ],
    remediation: "Run `agentq install --yes` to install Codex SessionStart, PreToolUse, and Stop hooks."
  },
  {
    adapter: "claude-code",
    relativePath: ".claude/settings.json",
    name: "Claude Code hook gate",
    commands: [
      "agentq hook claude-code session-start",
      "agentq hook claude-code pre-tool",
      "agentq hook claude-code stop"
    ],
    remediation: "Run `agentq install --yes` to install Claude Code SessionStart, PreToolUse, and Stop hooks."
  },
  {
    adapter: "copilot-cli",
    relativePath: ".github/hooks/agentq.json",
    name: "Copilot hook gate",
    commands: [
      "agentq hook copilot-cli session-start",
      "agentq hook copilot-cli pre-tool",
      "agentq hook copilot-cli stop"
    ],
    remediation: "Run `agentq install --yes` to install Copilot sessionStart, preToolUse, and agentStop hooks."
  }
] as const;

export async function runDoctor(
  workspaceRoot: string,
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const store = await resolveWorkspaceStore(workspaceRoot, workspaceOptions(options));
  const checks: DoctorCheck[] = [];

  checks.push(await checkRuntimeStore(store.layout.root));
  checks.push(...(await checkInstructionMarkers(store.workspaceRoot)));
  checks.push(...(await checkHookTargets(store.workspaceRoot)));
  checks.push(await checkCodexProjectHooksFeature(store.workspaceRoot));
  checks.push(await checkCopilotRepositorySettings(store.workspaceRoot));
  checks.push(checkCopilotPromptModeRepoHooks(options.env));
  checks.push(checkCopilotCloudScope());
  checks.push(await checkRepoLocalRuntime(store.workspaceRoot));
  checks.push(await checkCommittedConfig(store.workspaceRoot));

  return {
    workspaceRoot: store.workspaceRoot,
    storePath: store.layout.root,
    summary: summarize(checks),
    checks
  };
}

function workspaceOptions(options: DoctorOptions): WorkspaceStoreOptions {
  const resolved: WorkspaceStoreOptions = {};
  if (options.platform !== undefined) {
    return options.env === undefined
      ? { ...resolved, platform: options.platform }
      : { ...resolved, platform: options.platform, env: options.env };
  }

  return options.env === undefined ? resolved : { ...resolved, env: options.env };
}

async function checkRuntimeStore(storePath: string): Promise<DoctorCheck> {
  if (await exists(storePath)) {
    return {
      level: "ok",
      name: "OS-local runtime store",
      detail: `found at ${storePath}`
    };
  }

  return {
    level: "ok",
    name: "OS-local runtime store",
    detail: `not created yet; first hook or queue command will create ${storePath}`
  };
}

async function checkInstructionMarkers(workspaceRoot: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  for (const target of DEFAULT_MARKER_TARGETS) {
    const filePath = path.join(workspaceRoot, target.relativePath);
    const content = await readOptionalText(filePath);
    if (content === undefined) {
      checks.push({
        level: "warn",
        name: target.label,
        detail: `${target.relativePath} is missing`,
        remediation: "Run `agentq install --yes` to insert instruction markers."
      });
      continue;
    }

    if (!content.includes(AGENTQ_MARKER_BEGIN)) {
      checks.push({
        level: "warn",
        name: target.label,
        detail: `${target.relativePath} exists without an AgentQ marker`,
        remediation: "Run `agentq install --yes` or add the marker manually after reviewing the file."
      });
      continue;
    }

    checks.push({
      level: "ok",
      name: target.label,
      detail: `${target.relativePath} contains AgentQ marker`
    });
  }

  return checks;
}

async function checkHookTargets(workspaceRoot: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  for (const target of HOOK_TARGETS) {
    const filePath = path.join(workspaceRoot, target.relativePath);
    const content = await readOptionalText(filePath);
    const missingCommands = target.commands.filter((command) => content?.includes(command) !== true);
    if (content !== undefined && missingCommands.length !== target.commands.length) {
      const disabledCheck = disabledHookCheck(target.adapter, target.relativePath, content);
      if (disabledCheck !== undefined) {
        checks.push(disabledCheck);
        continue;
      }

      if (missingCommands.length > 0) {
        checks.push({
          level: "warn",
          name: target.name,
          detail: `${target.relativePath} contains partial AgentQ hook entries; missing ${missingCommands.join(", ")}`,
          remediation: target.remediation
        });
        continue;
      }

      checks.push({
        level: "ok",
        name: target.name,
        detail: `${target.relativePath} contains all AgentQ hook entries`
      });
      continue;
    }

    checks.push({
      level: "warn",
      name: target.name,
      detail: content !== undefined
        ? `${target.relativePath} exists but AgentQ adapter ownership is not verified in this build`
        : `${target.relativePath} is not installed; active stop gate is not claimed`,
      remediation: target.remediation
    });
  }

  return checks;
}

async function checkCodexProjectHooksFeature(workspaceRoot: string): Promise<DoctorCheck> {
  const relativePath = ".codex/config.toml";
  const content = await readOptionalText(path.join(workspaceRoot, relativePath));
  if (content !== undefined && /\bhooks\s*=\s*false\b/.test(content)) {
    return {
      level: "fail",
      name: "Codex hooks feature",
      detail: `${relativePath} appears to disable hooks`,
      remediation: "Remove the local hooks=false setting or enable hooks before relying on AgentQ Stop gates."
    };
  }

  return {
    level: "ok",
    name: "Codex hooks feature",
    detail: `${relativePath} does not disable hooks; project trust/review must be verified in Codex with /hooks`
  };
}

async function checkCopilotRepositorySettings(workspaceRoot: string): Promise<DoctorCheck> {
  const settingsPaths = [
    ".github/copilot/settings.json",
    ".github/copilot/settings.local.json"
  ];

  for (const relativePath of settingsPaths) {
    const content = await readOptionalText(path.join(workspaceRoot, relativePath));
    if (content !== undefined && jsonBoolean(content, "disableAllHooks") === true) {
      return {
        level: "fail",
        name: "Copilot repository hook settings",
        detail: `${relativePath} disables all Copilot hooks for local CLI sessions`,
        remediation: "Set disableAllHooks to false or remove it before relying on AgentQ Copilot gates."
      };
    }
  }

  return {
    level: "ok",
    name: "Copilot repository hook settings",
    detail: "no repository-level Copilot disableAllHooks setting found"
  };
}

function checkCopilotPromptModeRepoHooks(env: NodeJS.ProcessEnv | undefined): DoctorCheck {
  if (env?.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS === "true") {
    return {
      level: "ok",
      name: "Copilot prompt-mode repo hooks",
      detail: "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true is set; `copilot -p` can load repository hook files"
    };
  }

  return {
    level: "ok",
    name: "Copilot prompt-mode repo hooks",
    detail: "`copilot -p` loads repository hook files only when the folder is trusted or GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true is set",
    remediation: "For non-interactive Copilot CLI probes or CI, set GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true before relying on repository hooks."
  };
}

function checkCopilotCloudScope(): DoctorCheck {
  return {
    level: "ok",
    name: "Copilot cloud scope",
    detail: "local CLI gate is active; cloud agent remains advisory until AgentQ has remote/shared transport"
  };
}

async function checkRepoLocalRuntime(workspaceRoot: string): Promise<DoctorCheck> {
  const relativePath = ".agentq";
  if (await exists(path.join(workspaceRoot, relativePath))) {
    return {
      level: "fail",
      name: "repo-local runtime state",
      detail: `${relativePath}/ exists inside the repository`,
      remediation: "Remove or migrate repo-local runtime state; AgentQ runtime state must stay OS-local."
    };
  }

  return {
    level: "ok",
    name: "repo-local runtime state",
    detail: "no repo .agentq directory found"
  };
}

async function checkCommittedConfig(workspaceRoot: string): Promise<DoctorCheck> {
  const relativePath = "agentq.config.yaml";
  if (await exists(path.join(workspaceRoot, relativePath))) {
    return {
      level: "fail",
      name: "committed project config",
      detail: `${relativePath} exists but AgentQ does not use project config`,
      remediation: "Remove the config file and use `agentq doctor` for state explanation."
    };
  }

  return {
    level: "ok",
    name: "committed project config",
    detail: "no agentq.config.yaml found"
  };
}

function summarize(checks: readonly DoctorCheck[]): DoctorLevel {
  if (checks.some((check) => check.level === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.level === "warn")) {
    return "warn";
  }

  return "ok";
}

function disabledHookCheck(
  adapter: "codex" | "claude-code" | "copilot-cli",
  relativePath: string,
  content: string
): DoctorCheck | undefined {
  if (adapter === "claude-code" && jsonBoolean(content, "disableAllHooks") === true) {
    return {
      level: "fail",
      name: "Claude Code hook gate",
      detail: `${relativePath} contains AgentQ hook entries but disableAllHooks is true`,
      remediation: "Set disableAllHooks to false or remove it before relying on AgentQ Stop gates."
    };
  }

  if (adapter === "copilot-cli" && jsonBoolean(content, "disableAllHooks") === true) {
    return {
      level: "fail",
      name: "Copilot hook gate",
      detail: `${relativePath} contains AgentQ hook entries but disableAllHooks is true`,
      remediation: "Set disableAllHooks to false or remove it before relying on AgentQ agentStop gates."
    };
  }

  return undefined;
}

function jsonBoolean(content: string, key: string): boolean | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const value = (parsed as { readonly [key: string]: unknown })[key];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
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
