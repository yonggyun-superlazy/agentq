#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runClaudeHook } from "./adapters/claude.js";
import { runCodexHook } from "./adapters/codex.js";
import { inspectProjectHooks } from "./installer/doctor.js";
import {
  HookConfigError,
  installProjectHooks,
  uninstallProjectHooks,
  type FirstPartyAdapter
} from "./installer/hookConfig.js";
import {
  AGENTQ_NAME,
  AGENTQ_POSITIONING,
  AGENTQ_TAGLINE,
  answerQuestion,
  cancelQuestion,
  clearClaims,
  createQuestion,
  declineQuestionAsNotMine,
  ensureWorkspaceStore,
  findOwners,
  listInbox,
  registerAdapterSession,
  resolveWorkspaceStore,
  setClaims,
  type ClaimSnapshot,
  type WorkspaceStore
} from "@agentq/core";

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: readonly string[];
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRuntime {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => string;
  readonly readStdin?: () => Promise<string>;
  readonly nodePath?: string;
  readonly entrypointPath?: string;
}

const PUBLIC_USAGE = {
  register: "agentq register --adapter <adapter-id> --session <native-id>",
  claimsSet:
    "agentq claims set --actor <id> [--path <path>]... [--resource <id>]... [--contract <id>]...",
  claimsClear: "agentq claims clear --actor <id>",
  owners:
    "agentq owners --actor <requester> [--path <path>]... [--resource <id>]... [--contract <id>]...",
  question:
    "agentq question --actor <sender> --to <recipient> --question <text> [scope options]",
  answer: "agentq answer <question-id> --actor <recipient> --answer <text>",
  notMine: "agentq not_mine <question-id> --actor <recipient>",
  cancel: "agentq cancel <question-id> --actor <sender>",
  inbox: "agentq inbox --actor <recipient>",
  install: "agentq install [--adapter codex|claude|all] [--dry-run|--yes]",
  uninstall: "agentq uninstall [--adapter codex|claude|all] [--dry-run|--yes]",
  doctor: "agentq doctor",
  hook: "agentq hook <codex|claude> <session-start|pre-tool-use>"
} as const;

export const COMMANDS: readonly CommandSpec[] = [
  { name: "register", summary: "Register an exact native session", usage: [PUBLIC_USAGE.register] },
  {
    name: "claims",
    summary: "Replace or clear one actor claim snapshot",
    usage: [PUBLIC_USAGE.claimsSet, PUBLIC_USAGE.claimsClear]
  },
  { name: "owners", summary: "Read actors with overlapping claims", usage: [PUBLIC_USAGE.owners] },
  { name: "question", summary: "Create one explicit required question", usage: [PUBLIC_USAGE.question] },
  { name: "answer", summary: "Answer as the selected recipient", usage: [PUBLIC_USAGE.answer] },
  { name: "not_mine", summary: "Decline a wrongly routed question", usage: [PUBLIC_USAGE.notMine] },
  { name: "cancel", summary: "Cancel a pending sent question", usage: [PUBLIC_USAGE.cancel] },
  { name: "inbox", summary: "Read pending received questions", usage: [PUBLIC_USAGE.inbox] },
  { name: "install", summary: "Install project-local client integration", usage: [PUBLIC_USAGE.install] },
  { name: "uninstall", summary: "Remove owned project-local integration", usage: [PUBLIC_USAGE.uninstall] },
  { name: "doctor", summary: "Inspect explicit diagnostics", usage: [PUBLIC_USAGE.doctor] },
  { name: "hook", summary: "Run one first-party client boundary", usage: [PUBLIC_USAGE.hook] }
];

export function renderHelp(): string {
  return [
    AGENTQ_NAME,
    AGENTQ_TAGLINE,
    "",
    AGENTQ_POSITIONING,
    "",
    "Usage:",
    ...COMMANDS.flatMap((command) => command.usage.map((usage) => `  ${usage}`))
  ].join("\n");
}

export async function runCommand(
  argv: readonly string[],
  runtime: CommandRuntime = defaultRuntime()
): Promise<CommandResult> {
  const args = [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return successText(`${renderHelp()}\n`);
  }

  const command = args[0] ?? "";
  const spec = COMMANDS.find((candidate) => candidate.name === command);
  if (spec === undefined) {
    return failure("unknown_command", `unknown command: ${command}`);
  }
  if (args.includes("--help")) {
    if (command === "claims" && (args[1] === "set" || args[1] === "clear")) {
      const usage = args[1] === "set" ? PUBLIC_USAGE.claimsSet : PUBLIC_USAGE.claimsClear;
      return successText(`${usage}\n`);
    }
    return successText(`${spec.usage.join("\n")}\n`);
  }

  try {
    switch (command) {
      case "register":
        return await runRegister(args.slice(1), runtime);
      case "claims":
        return await runClaims(args.slice(1), runtime);
      case "owners":
        return await runOwners(args.slice(1), runtime);
      case "question":
        return await runQuestion(args.slice(1), runtime);
      case "answer":
        return await runAnswer(args.slice(1), runtime);
      case "not_mine":
        return await runNotMine(args.slice(1), runtime);
      case "cancel":
        return await runCancel(args.slice(1), runtime);
      case "inbox":
        return await runInbox(args.slice(1), runtime);
      case "install":
        return await runInstallCommand(args.slice(1), runtime, false);
      case "uninstall":
        return await runInstallCommand(args.slice(1), runtime, true);
      case "doctor":
        return await runDoctorCommand(args.slice(1), runtime);
      case "hook":
        return await runHookCommand(args.slice(1), runtime);
    }
  } catch (error) {
    if (error instanceof CliDiagnostic) {
      return failure(error.code, error.message);
    }
    if (error instanceof HookConfigError) {
      return failure(error.code, error.message);
    }
    return failure("operation_failed", error instanceof Error ? error.message : String(error));
  }

  return failure("unknown_command", `unknown command: ${command}`);
}

async function runRegister(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const adapterId = requiredOption(parsed, "adapter");
  const nativeSessionId = requiredOption(parsed, "session");
  const store = await openStore(runtime);
  const result = await registerAdapterSession(store, {
    adapterId,
    nativeSessionId,
    cwd: runtime.cwd,
    now: runtime.now()
  });
  if (result.status === "unavailable") {
    return failure(
      "registration_unavailable",
      [result.reason, result.diagnostic].filter((value) => value !== undefined).join(": ")
    );
  }
  return successJson("registered", { actorId: result.actorId });
}

async function runClaims(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const subcommand = args[0];
  if (subcommand !== "set" && subcommand !== "clear") {
    throw new CliDiagnostic("invalid_arguments", "claims requires set or clear");
  }
  const parsed = parseArguments(args.slice(1));
  const actorId = requiredOption(parsed, "actor");
  const store = await openStore(runtime);
  if (subcommand === "clear") {
    const claims = await clearClaims(store, actorId);
    return successJson("claims_cleared", { actorId, claims });
  }
  const claims = await setClaims(store, actorId, claimScope(parsed));
  return successJson("claims_set", { actorId, claims });
}

async function runOwners(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const requesterActorId = requiredOption(parsed, "actor");
  const store = await openStore(runtime);
  const owners = await findOwners(store, requesterActorId, claimScope(parsed));
  return successJson("owners", { owners });
}

async function runQuestion(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const store = await openStore(runtime);
  const question = await createQuestion(store, {
    senderActorId: requiredOption(parsed, "actor"),
    recipientActorId: requiredOption(parsed, "to"),
    question: requiredOption(parsed, "question"),
    scope: claimScope(parsed),
    now: runtime.now()
  });
  return successJson("question_created", { questionId: question.id, status: question.status });
}

async function runAnswer(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const questionId = requiredPositional(parsed, "question-id");
  const store = await openStore(runtime);
  const question = await answerQuestion(
    store,
    questionId,
    requiredOption(parsed, "actor"),
    requiredOption(parsed, "answer"),
    runtime.now()
  );
  return successJson("question_answered", { questionId, status: question.status });
}

async function runNotMine(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const questionId = requiredPositional(parsed, "question-id");
  const store = await openStore(runtime);
  const question = await declineQuestionAsNotMine(
    store,
    questionId,
    requiredOption(parsed, "actor"),
    runtime.now()
  );
  return successJson("question_not_mine", { questionId, status: question.status });
}

async function runCancel(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const questionId = requiredPositional(parsed, "question-id");
  const store = await openStore(runtime);
  const question = await cancelQuestion(
    store,
    questionId,
    requiredOption(parsed, "actor"),
    runtime.now()
  );
  return successJson("question_cancelled", { questionId, status: question.status });
}

async function runInbox(args: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const parsed = parseArguments(args);
  const store = await openStore(runtime);
  const questions = await listInbox(store, requiredOption(parsed, "actor"));
  return successJson("inbox", { questions });
}

async function runHookCommand(
  args: readonly string[],
  runtime: CommandRuntime
): Promise<CommandResult> {
  const adapter = args[0];
  const event = args[1];
  if (adapter !== "codex" && adapter !== "claude") {
    throw new CliDiagnostic("invalid_arguments", "hook requires codex or claude");
  }
  if (event !== "session-start" && event !== "pre-tool-use") {
    throw new CliDiagnostic(
      "invalid_arguments",
      "hook requires session-start or pre-tool-use"
    );
  }

  const source = await readHookStdin(runtime);
  if (source.trim().length === 0) {
    return { code: 0, stdout: "", stderr: "" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    return { code: 0, stdout: "", stderr: "" };
  }
  const result = adapter === "codex"
    ? await runCodexHook(payload, { env: runtime.env, now: runtime.now })
    : await runClaudeHook(payload, { env: runtime.env, now: runtime.now });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function runInstallCommand(
  args: readonly string[],
  runtime: CommandRuntime,
  uninstall: boolean
): Promise<CommandResult> {
  const parsed = parseInstallArguments(args);
  const input = {
    workspaceRoot: runtime.cwd,
    adapters: parsed.adapters,
    handlerCommand: handlerCommand(runtime),
    mutate: parsed.mutate
  };
  const result = uninstall
    ? await uninstallProjectHooks(input)
    : await installProjectHooks(input);
  return successJson(
    uninstall
      ? parsed.mutate ? "uninstalled" : "uninstall_plan"
      : parsed.mutate ? "installed" : "install_plan",
    result as unknown as Record<string, unknown>
  );
}

async function runDoctorCommand(
  args: readonly string[],
  runtime: CommandRuntime
): Promise<CommandResult> {
  if (args.length > 0) {
    throw new CliDiagnostic("invalid_arguments", "doctor accepts no arguments");
  }
  const diagnostics = await inspectProjectHooks(runtime.cwd, handlerCommand(runtime));
  return successJson("doctor", { diagnostics });
}

interface ParsedArguments {
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliDiagnostic("invalid_arguments", `missing --${name} value`);
    }
    options.set(name, [...(options.get(name) ?? []), value]);
    index += 1;
  }
  return { positional, options };
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.options.get(name)?.at(-1);
  if (value === undefined || value.length === 0) {
    throw new CliDiagnostic("invalid_arguments", `missing --${name}`);
  }
  return value;
}

function requiredPositional(parsed: ParsedArguments, label: string): string {
  const value = parsed.positional[0];
  if (value === undefined || value.length === 0) {
    throw new CliDiagnostic("invalid_arguments", `missing <${label}>`);
  }
  return value;
}

function claimScope(parsed: ParsedArguments): ClaimSnapshot {
  return {
    paths: parsed.options.get("path") ?? [],
    resources: parsed.options.get("resource") ?? [],
    contracts: parsed.options.get("contract") ?? []
  };
}

function parseInstallArguments(args: readonly string[]): {
  readonly adapters: readonly FirstPartyAdapter[];
  readonly mutate: boolean;
} {
  let adapter: "all" | FirstPartyAdapter = "all";
  let yes = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--yes") {
      yes = true;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--adapter") {
      const value = args[index + 1];
      if (value !== "codex" && value !== "claude" && value !== "all") {
        throw new CliDiagnostic("invalid_adapter", "install adapter must be codex, claude, or all");
      }
      adapter = value;
      index += 1;
    } else {
      throw new CliDiagnostic("invalid_arguments", `unexpected install argument: ${token ?? ""}`);
    }
  }
  if (yes && dryRun) {
    throw new CliDiagnostic("invalid_arguments", "--yes and --dry-run are mutually exclusive");
  }
  return {
    adapters: adapter === "all" ? ["codex", "claude"] : [adapter],
    mutate: yes
  };
}

function handlerCommand(runtime: CommandRuntime): string {
  const nodePath = runtime.nodePath ?? process.execPath;
  const entrypointPath = runtime.entrypointPath ?? fileURLToPath(import.meta.url);
  if (!pathIsAbsolute(nodePath) || !pathIsAbsolute(entrypointPath)) {
    throw new CliDiagnostic("invalid_handler_command", "handler paths must be absolute");
  }
  return `${quoteCommandPart(nodePath)} ${quoteCommandPart(entrypointPath)}`;
}

function pathIsAbsolute(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(value);
}

function quoteCommandPart(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function openStore(runtime: CommandRuntime): Promise<WorkspaceStore> {
  const store = await resolveWorkspaceStore(runtime.cwd, { env: runtime.env });
  await ensureWorkspaceStore(store);
  return store;
}

async function readHookStdin(runtime: CommandRuntime): Promise<string> {
  if (runtime.readStdin !== undefined) {
    return await runtime.readStdin();
  }
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function successJson(code: string, fields: Record<string, unknown>): CommandResult {
  return { code: 0, stdout: `${JSON.stringify({ code, ...fields })}\n`, stderr: "" };
}

function successText(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function failure(code: string, message: string): CommandResult {
  return { code: 2, stdout: "", stderr: `agentq:${code}: ${message}\n` };
}

class CliDiagnostic extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function defaultRuntime(): CommandRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    now: () => new Date().toISOString()
  };
}

async function runProcess(): Promise<void> {
  const result = await runCommand(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

function isMainEntrypoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

if (isMainEntrypoint(process.argv[1], import.meta.url)) {
  void runProcess();
}
