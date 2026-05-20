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
}

export async function runWakeCommand(
  argv: readonly string[],
  runtime: WakeCommandRuntime
): Promise<WakeCommandResult> {
  const subcommand = argv[0] === "list" ? "list" : null;
  const args = parseArgs(subcommand === null ? argv : argv.slice(1));
  const store = await openStore(runtime);

  if (args.flags.has("execute")) {
    throw new Error("wake --execute was removed because it started headless agent turns. Use wake to inspect pending targets, then continue in the visible agent TUI.");
  }
  if (args.options.has("timeout-ms")) {
    throw new Error("wake --timeout-ms is no longer supported because wake does not execute agent processes.");
  }

  if (subcommand === "list") {
    const targets = await listWakeTargets(store);
    return {
      code: 0,
      stdout: targets.length === 0 ? "no wake targets\n" : renderWakeTargetList(targets),
      stderr: ""
    };
  }

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

  return {
    code: 0,
    stdout: renderWakeInspection(targets),
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
      summary = {
        actorId: recipient.actorId,
        messageIds,
        status: "record_only",
        adapter: binding.adapter,
        sessionId: binding.sessionId,
        evidence: [`AgentQ recorded pending delivery for ${recipient.actorId}; headless resume execution is disabled.`]
      };
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
        pending
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
    pending
  };
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

function renderWakeTargetList(targets: readonly WakeTarget[]): string {
  return [
    `wake targets: ${targets.length}`,
    "",
    targets.map((target) => [
      target.actor.actorId,
      `  kind: ${target.actor.kind}`,
      `  session: ${target.binding.sessionId}`,
      `  pending: ${target.pending.map((item) => item.state.message.id).join(", ")}`,
      `  inbox: agentq inbox --actor ${target.actor.actorId}`
    ].join("\n")).join("\n\n")
  ].join("\n") + "\n";
}

function renderWakeInspection(targets: readonly WakeTarget[]): string {
  return [
    "agentq wake inspect",
    "headless resume execution is removed; continue in the visible agent TUI.",
    "",
    targets.map(renderWakeTarget).join("\n\n")
  ].join("\n") + "\n";
}

function renderWakeTarget(target: WakeTarget): string {
  return [
    target.actor.actorId,
    `  kind: ${target.actor.kind}`,
    `  session: ${target.binding.sessionId}`,
    `  pending: ${target.pending.map((item) => item.state.message.id).join(", ")}`,
    `  inbox: agentq inbox --actor ${target.actor.actorId}`,
    "  delivery: recorded only; no agent process was started"
  ].join("\n");
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
