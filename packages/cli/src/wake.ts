import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  findSessionBindingByActorId,
  listActorPresences,
  listPendingInboxItems,
  resolveWorkspaceStore,
  ensureWorkspaceStore,
  writeOnceYaml,
  type DeliveryAttemptStatus,
  type FoldedMessageState,
  type FoldedRequest,
  type Presence,
  type RequiredRequestRoutePlan,
  type SessionBinding,
  type WorkspaceStore
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

export interface DeliveryCommandRuntime extends WakeCommandRuntime {
  readonly now: () => string;
  readonly deliveryMode?: "execute" | "record";
}

export interface DeliveryAttemptSummary {
  readonly actorId: string;
  readonly messageIds: readonly string[];
  readonly status: DeliveryAttemptStatus;
  readonly adapter?: SessionBinding["adapter"];
  readonly sessionId?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly evidence: readonly string[];
}

export interface DeliveryReport {
  readonly attempts: readonly DeliveryAttemptSummary[];
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

export async function deliverRoutedRequests(
  store: WorkspaceStore,
  plan: RequiredRequestRoutePlan,
  runtime: DeliveryCommandRuntime
): Promise<DeliveryReport> {
  const mode = deliveryMode(runtime);
  const actors = await listActorPresences(store);
  const attempts: DeliveryAttemptSummary[] = [];

  for (const recipient of plan.recipients) {
    const actor = actors.find((candidate) => candidate.actorId === recipient.actorId);
    const pending = await listPendingInboxItems(store, recipient.actorId);
    const messageIds = pending.map((item) => item.state.message.id);
    const binding = await findSessionBindingByActorId(store, recipient.actorId);

    let summary: DeliveryAttemptSummary;
    if (actor === undefined || binding === null) {
      summary = {
        actorId: recipient.actorId,
        messageIds: [plan.message.id],
        status: "no_binding",
        evidence: [`AgentQ delivery did not find a session binding for ${recipient.actorId}.`]
      };
    } else if (pending.length === 0) {
      summary = {
        actorId: recipient.actorId,
        messageIds: [plan.message.id],
        status: "failed",
        adapter: binding.adapter,
        sessionId: binding.sessionId,
        evidence: [`AgentQ delivery found no pending inbox request for ${recipient.actorId}.`]
      };
    } else {
      const target: WakeTarget = {
        actor,
        binding,
        pending,
        command: buildWakeCommand(actor, binding, pending)
      };
      if (mode === "record") {
        summary = {
          actorId: recipient.actorId,
          messageIds,
          status: "record_only",
          adapter: binding.adapter,
          sessionId: binding.sessionId,
          command: target.command.executable,
          evidence: [`AgentQ recorded delivery plan for ${recipient.actorId}; execution disabled for this runtime.`]
        };
      } else {
        const result = await executeWakeTarget(target, runtime, 600000);
        summary = {
          actorId: recipient.actorId,
          messageIds,
          status: result.timedOut ? "timed_out" : result.code === 0 ? "executed" : "failed",
          adapter: binding.adapter,
          sessionId: binding.sessionId,
          command: target.command.executable,
          exitCode: result.code,
          timedOut: result.timedOut,
          evidence: [
            result.timedOut
              ? `AgentQ delivery timed out for ${recipient.actorId}.`
              : `AgentQ delivery exited ${result.code} for ${recipient.actorId}.`
          ]
        };
      }
    }

    await writeDeliveryAttempt(store, plan.message.id, summary, runtime.now());
    attempts.push(summary);
  }

  return { attempts };
}

export function renderDeliveryReport(report: DeliveryReport): string {
  if (report.attempts.length === 0) {
    return "delivery: no recipients";
  }

  return [
    "delivery:",
    ...report.attempts.map((attempt) => {
      const details = [
        attempt.status,
        attempt.command === undefined ? null : `command=${attempt.command}`,
        attempt.exitCode === undefined ? null : `exit=${attempt.exitCode}`,
        attempt.timedOut === undefined ? null : `timedOut=${attempt.timedOut}`
      ].filter((value): value is string => value !== null);
      return `  ${attempt.actorId}: ${details.join(" ")}`;
    })
  ].join("\n");
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

function deliveryMode(runtime: DeliveryCommandRuntime): "execute" | "record" {
  if (runtime.env.AGENTQ_DELIVERY_MODE === "record") {
    return "record";
  }

  return runtime.deliveryMode ?? "record";
}

async function writeDeliveryAttempt(
  store: WorkspaceStore,
  messageId: string,
  summary: DeliveryAttemptSummary,
  at: string
): Promise<void> {
  const event = {
    kind: "delivery_attempt",
    id: `EV-delivery-${randomUUID()}`,
    messageId,
    actorId: summary.actorId,
    status: summary.status,
    ...(summary.adapter === undefined ? {} : { adapter: summary.adapter }),
    ...(summary.sessionId === undefined ? {} : { sessionId: summary.sessionId }),
    ...(summary.exitCode === undefined ? {} : { exitCode: summary.exitCode }),
    ...(summary.timedOut === undefined ? {} : { timedOut: summary.timedOut }),
    evidence: [...summary.evidence],
    at
  };

  EventSchema.parse(event);
  await writeOnceYaml(store.layout.eventPath(messageId, event.id), event);
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
