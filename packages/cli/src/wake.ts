import { spawn } from "node:child_process";
import {
  findSessionBindingByActorId,
  listActorPresences,
  listPendingInboxItems,
  resolveWorkspaceStore,
  ensureWorkspaceStore,
  type FoldedMessageState,
  type FoldedRequest,
  type Presence,
  type SessionBinding
} from "@agentq/core";

export interface WakeCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WakeCommandRuntime {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface WakeTarget {
  readonly actor: Presence;
  readonly binding: SessionBinding;
  readonly pending: readonly {
    readonly state: FoldedMessageState;
    readonly request: FoldedRequest;
  }[];
  readonly command: WakeCommandPlan;
}

interface WakeCommandPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly policy: "supported" | "limited";
  readonly timeoutMs?: number;
}

interface ExecutedWake {
  readonly target: WakeTarget;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function runWakeCommand(
  argv: readonly string[],
  runtime: WakeCommandRuntime
): Promise<WakeCommandResult> {
  const subcommand = argv[0] === "list" ? "list" : null;
  const args = parseArgs(subcommand === null ? argv : argv.slice(1));
  const store = await openStore(runtime);
  const timeoutMs = Number(optionValue(args, "timeout-ms") ?? "600000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("wake --timeout-ms must be a positive number.");
  }

  if (subcommand === "list") {
    const targets = await listWakeTargets(store);
    return {
      code: 0,
      stdout: targets.length === 0 ? "no wake targets\n" : renderWakeTargetList(targets),
      stderr: ""
    };
  }

  const dryRun = !args.flags.has("execute") || args.flags.has("dry-run");
  const targets = args.flags.has("all")
    ? await listWakeTargets(store)
    : [await resolveWakeTarget(store, requiredOption(args, "actor"))];

  if (targets.length === 0) {
    return {
      code: 0,
      stdout: "no wake targets\n",
      stderr: ""
    };
  }

  if (dryRun) {
    return {
      code: 0,
      stdout: renderWakeDryRun(targets),
      stderr: ""
    };
  }

  const executed: ExecutedWake[] = [];
  for (const target of targets) {
    executed.push(await executeWakeTarget(target, runtime, timeoutMs));
  }
  const failed = executed.some((result) => result.code !== 0 || result.timedOut);

  return {
    code: failed ? 2 : 0,
    stdout: renderWakeExecution(executed),
    stderr: ""
  };
}

async function openStore(runtime: WakeCommandRuntime) {
  const store = await resolveWorkspaceStore(runtime.cwd, {
    env: runtime.env
  });
  await ensureWorkspaceStore(store);
  return store;
}

async function listWakeTargets(store: Awaited<ReturnType<typeof openStore>>): Promise<WakeTarget[]> {
  const actors = await listActorPresences(store);
  const targets: WakeTarget[] = [];
  for (const actor of actors) {
    const pending = await listPendingInboxItems(store, actor.actorId);
    if (pending.length === 0) {
      continue;
    }
    const binding = await findSessionBindingByActorId(store, actor.actorId);
    if (binding !== null) {
      targets.push({
        actor,
        binding,
        pending,
        command: buildWakeCommand(actor, binding, pending)
      });
    }
  }

  return targets;
}

async function resolveWakeTarget(
  store: Awaited<ReturnType<typeof openStore>>,
  actorId: string
): Promise<WakeTarget> {
  const actors = await listActorPresences(store);
  const actor = actors.find((candidate) => candidate.actorId === actorId);
  if (actor === undefined) {
    throw new Error(`wake actor is unknown: ${actorId}`);
  }

  const pending = await listPendingInboxItems(store, actorId);
  if (pending.length === 0) {
    throw new Error(`wake actor has no pending inbox requests: ${actorId}`);
  }

  const binding = await findSessionBindingByActorId(store, actorId);
  if (binding === null) {
    throw new Error(`wake actor has no session binding: ${actorId}`);
  }

  return {
    actor,
    binding,
    pending,
    command: buildWakeCommand(actor, binding, pending)
  };
}

function buildWakeCommand(
  actor: Presence,
  binding: SessionBinding,
  pending: readonly {
    readonly state: FoldedMessageState;
    readonly request: FoldedRequest;
  }[]
): WakeCommandPlan {
  const prompt = buildWakePrompt(actor.actorId, pending);
  if (binding.adapter === "claude-code") {
    return {
      executable: "claude",
      args: ["-p", prompt, "--resume", binding.sessionId, "--tools", "Bash", "--allowedTools", "Bash(agentq *)"],
      prompt,
      policy: "supported"
    };
  }

  if (binding.adapter === "codex") {
    return {
      executable: "codex",
      args: ["exec", "resume", binding.sessionId, "--skip-git-repo-check", "--json", prompt],
      prompt,
      policy: "supported"
    };
  }

  if (binding.adapter === "copilot-cli") {
    return {
      executable: "copilot",
      args: ["-C", binding.workspaceRoot, `--resume=${binding.sessionId}`, "-p", prompt, "--output-format", "json", "--silent"],
      prompt,
      policy: "limited",
      timeoutMs: 120000
    };
  }

  throw new Error(`wake does not know how to resume adapter: ${binding.adapter}`);
}

function buildWakePrompt(
  actorId: string,
  pending: readonly {
    readonly state: FoldedMessageState;
    readonly request: FoldedRequest;
  }[]
): string {
  const messageIds = pending.map((item) => item.state.message.id);

  return [
    "AgentQ wake request.",
    `You are AgentQ actor ${actorId}.`,
    `Process only these pending AgentQ messages: ${messageIds.join(", ")}.`,
    "Do not edit files unless a pending request explicitly requires a file edit.",
    `Run: agentq inbox --actor ${actorId}`,
    "Answer each relevant pending request with agentq respond and concrete evidence.",
    "If a request cannot be answered, respond with --status blocked and explain the missing evidence.",
    "Do not create unrelated work. Do not change actor scope solely because this wake prompt ran.",
    "If a final gate asks for scope, refresh with your real current owned paths and responsibilities, not with the wake request itself.",
    "Stop after the pending AgentQ request set is resolved or explicitly blocked."
  ].join("\n");
}

function renderWakeTargetList(targets: readonly WakeTarget[]): string {
  return [
    `wake targets: ${targets.length}`,
    "",
    targets.map((target) => [
      target.actor.actorId,
      `  kind: ${target.actor.kind}`,
      `  session: ${target.binding.sessionId}`,
      `  pending: ${target.pending.map((item) => item.state.message.id).join(", ")}`,
      `  policy: ${target.command.policy}`
    ].join("\n")).join("\n\n")
  ].join("\n") + "\n";
}

function renderWakeDryRun(targets: readonly WakeTarget[]): string {
  return [
    "agentq wake dry-run",
    "",
    targets.map(renderWakeTargetCommand).join("\n\n")
  ].join("\n") + "\n";
}

function renderWakeTargetCommand(target: WakeTarget): string {
  return [
    target.actor.actorId,
    `  kind: ${target.actor.kind}`,
    `  session: ${target.binding.sessionId}`,
    `  pending: ${target.pending.map((item) => item.state.message.id).join(", ")}`,
    `  policy: ${target.command.policy}`,
    `  command: ${target.command.executable}`,
    "  args:",
    ...target.command.args.map((arg) => renderWakeArg(arg))
  ].join("\n");
}

function renderWakeArg(arg: string): string {
  if (!arg.includes("\n")) {
    return `    - ${arg}`;
  }

  return [
    "    - |",
    ...arg.split("\n").map((line) => `      ${line}`)
  ].join("\n");
}

async function executeWakeTarget(
  target: WakeTarget,
  runtime: WakeCommandRuntime,
  timeoutMs: number
): Promise<ExecutedWake> {
  const result = await spawnCapture(
    target.command.executable,
    target.command.args,
    {
      cwd: target.binding.workspaceRoot,
      env: runtime.env,
      timeoutMs: target.command.timeoutMs ?? timeoutMs
    }
  );

  return {
    target,
    ...result
  };
}

function renderWakeExecution(results: readonly ExecutedWake[]): string {
  return results.map((result) => [
    `agentq wake ${result.timedOut ? "timed out" : "executed"}: ${result.target.actor.actorId}`,
    `  command: ${result.target.command.executable}`,
    `  exit: ${result.code}`,
    `  pending: ${result.target.pending.map((item) => item.state.message.id).join(", ")}`,
    result.stdout.length === 0 ? "  stdout: (empty)" : `  stdout:\n${indent(truncate(result.stdout, 8000), 4)}`,
    result.stderr.length === 0 ? "  stderr: (empty)" : `  stderr:\n${indent(truncate(result.stderr, 8000), 4)}`
  ].join("\n")).join("\n\n") + "\n";
}

async function spawnCapture(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  }
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}\n`,
        timedOut
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code ?? 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut
      });
    });
  });
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.trimEnd().split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... truncated ${value.length - maxLength} chars ...`;
}

interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const options = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
      continue;
    }

    const existing = options.get(name) ?? [];
    options.set(name, [...existing, next]);
    index += 1;
  }

  return { flags, options, positionals };
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = optionValue(args, name);
  if (value === undefined) {
    throw new Error(`missing required option --${name}`);
  }

  return value;
}

function optionValue(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.[0];
}
