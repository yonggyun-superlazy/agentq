#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTQ_POSITIONING,
  AGENTQ_TAGLINE,
  applyHookConfigInstall,
  applyHookConfigUninstall,
  appendActiveWorkTouch,
  appendWorkEvidence,
  createOrRefreshSessionBinding,
  createRoutedBlocker,
  createRoutedRequest,
  ensureWorkspaceStore,
  EventSchema,
  foldMessageState,
  closeWork,
  applyMarkerInstall,
  applyMarkerUninstall,
  listPendingInboxItems,
  listActorPresences,
  planHookConfigInstall,
  planHookConfigUninstall,
  planMarkerInstall,
  planMarkerUninstall,
  planStopContinuation,
  planWorkStopContinuation,
  planScopeContinuation,
  refreshActorPresence,
  readActiveWorkState,
  resolveWorkspaceStore,
  runHookHandler,
  runScopeCheck,
  runDoctor,
  runWorkDoneCheck,
  startWork,
  actorScopeWeaknesses,
  type DoctorReport,
  type HookAdapter,
  type HookConfigPlan,
  type HookRuntimeEvent,
  type MarkerPlan,
  runDoneCheck,
  writeOnceYaml,
  type AgentKind,
  type FoldedMessageState,
  type FoldedRequest,
  type Message,
  type Presence,
  type ResponseStatus,
  type WorkState
} from "@agentq/core";
import { deliverRoutedRequests, renderDeliveryReport, runWakeCommand, type DeliveryReport } from "./wake.js";

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
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
  readonly deliveryMode?: "execute" | "record";
}

const DEFAULT_ACTOR_STALE_AFTER_MS = 3_600_000;

export const COMMANDS: readonly CommandSpec[] = [
  { name: "install", summary: "Install agent instructions and hook gates" },
  { name: "doctor", summary: "Explain AgentQ workspace and hook state" },
  { name: "uninstall", summary: "Remove AgentQ-owned integration markers and hook gates" },
  { name: "actors", summary: "List workspace actors by recent presence" },
  { name: "enter", summary: "Register actor presence and responsibilities" },
  { name: "work", summary: "Manage one explicit actor's internal work stack" },
  { name: "block", summary: "Create a required-response blocker" },
  { name: "question", summary: "Ask an actor a required-response question" },
  { name: "inbox", summary: "Show required requests for an explicit actor" },
  { name: "wake", summary: "Manually retry delivery to resumable CLI sessions" },
  { name: "respond", summary: "Resolve or answer a required request" },
  { name: "supersede", summary: "Cancel an outbound required request with evidence" },
  { name: "follow-up", summary: "Continue after a blocked response" },
  { name: "accept-blocked", summary: "Accept blocked evidence and unblock the sender" },
  { name: "scope-check", summary: "Fail when an actor has broad paths or generic responsibility" },
  { name: "done-check", summary: "Fail when required requests or active work remain unresolved" },
  { name: "hook", summary: "Run an AgentQ lifecycle hook handler" }
];

export function renderHelp(): string {
  return [
    "AgentQ",
    AGENTQ_TAGLINE,
    "",
    AGENTQ_POSITIONING,
    "",
    "Usage:",
    "  agentq <command>",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(17)} ${command.summary}`),
    "",
    "AgentQ is coordination, not orchestration. It does not assign work or create a boss agent."
  ].join("\n");
}

export function renderCommandHelp(command: CommandSpec): string {
  if (command.name === "install") {
    return [
      "agentq install",
      command.summary,
      "",
      "Usage:",
      "  agentq install [--dry-run]",
      "  agentq install --yes",
      "",
      "Dry-run is the default. Install writes AgentQ-owned instruction markers and hook gate entries."
    ].join("\n");
  }

  if (command.name === "uninstall") {
    return [
      "agentq uninstall",
      command.summary,
      "",
      "Usage:",
      "  agentq uninstall [--dry-run]",
      "  agentq uninstall --yes",
      "",
      "Dry-run is the default. Uninstall removes only AgentQ-owned marker blocks and hook entries."
    ].join("\n");
  }

  if (command.name === "work") {
    return [
      "agentq work",
      command.summary,
      "",
      "Usage:",
      "  agentq work start --actor <id> --title <title> [--path <path>...]",
      "  agentq work status --actor <id>",
      "  agentq work touch --actor <id> --path <path>...",
      "  agentq work evidence --actor <id> --evidence \"...\"",
      "  agentq work close --actor <id> --summary \"...\" [--evidence \"...\"]"
    ].join("\n");
  }

  if (command.name === "enter") {
    return [
      "agentq enter",
      command.summary,
      "",
      "Usage:",
      "  agentq enter --actor <id> [--paths <path>...] [--responsibility <text>...] [--summary <text>]",
      "  agentq enter --as <codex|claude-code|copilot-cli|custom> [--session <id>] [--paths <path>...] [--responsibility <text>...]",
      "",
      "Use --actor with the hook-provided actor id to refresh that exact actor. Use --as only to create or refresh a manual session binding."
    ].join("\n");
  }

  if (command.name === "block") {
    return [
      "agentq block",
      command.summary,
      "",
      "Usage:",
      "  agentq block --actor <id> --summary \"...\" [--to <id>...] [--id <id>] [--path <path>...] [--contract <name>...] [--pass \"...\"]",
      "",
      "If --to is omitted, AgentQ routes to active actors matched by path or contract.",
      "After routing, AgentQ attempts delivery to resumable sessions and records the result."
    ].join("\n");
  }

  if (command.name === "question") {
    return [
      "agentq question",
      command.summary,
      "",
      "Usage:",
      "  agentq question --actor <id> --question \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --path <path>... [--contract <name>...] [--expect \"...\"] [--pass \"...\"]",
      "  agentq question --actor <id> --question \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --contract <name>... [--expect \"...\"] [--pass \"...\"]",
      "",
      "Questions are required requests. The sender remains blocked until routed actors answer.",
      "After routing, AgentQ attempts delivery to resumable sessions and records the result."
    ].join("\n");
  }

  if (command.name === "inbox") {
    return [
      "agentq inbox",
      command.summary,
      "",
      "Usage:",
      "  agentq inbox --actor <id>",
      "",
      "Shows each pending request with sender, summary, path/contract context, pass criteria, and a response command."
    ].join("\n");
  }

  if (command.name === "wake") {
    return [
      "agentq wake",
      command.summary,
      "",
      "Usage:",
      "  agentq wake list",
      "  agentq wake --actor <id> [--dry-run]",
      "  agentq wake --actor <id> --execute [--timeout-ms <milliseconds>]",
      "  agentq wake --all [--dry-run]",
      "  agentq wake --all --execute [--timeout-ms <milliseconds>]",
      "",
      "Dry-run is the default. Execute retries delivery only for actors with pending inbox requests.",
      "Normal question/block commands already own the first delivery attempt.",
      "Adapter limits are handled by AgentQ and shown in dry-run output."
    ].join("\n");
  }

  if (command.name === "respond") {
    return [
      "agentq respond",
      command.summary,
      "",
      "Usage:",
      "  agentq respond <message-id> --actor <id> --status <resolved|answered|not_mine|invalid|blocked> --evidence \"...\""
    ].join("\n");
  }

  if (command.name === "supersede") {
    return [
      "agentq supersede",
      command.summary,
      "",
      "Usage:",
      "  agentq supersede <message-id> --actor <sender-id> --to <recipient-id> --evidence \"...\""
    ].join("\n");
  }

  if (command.name === "follow-up") {
    return [
      "agentq follow-up",
      command.summary,
      "",
      "Usage:",
      "  agentq follow-up <message-id> --actor <sender-id> --to <blocked-recipient-id> --evidence \"...\""
    ].join("\n");
  }

  if (command.name === "accept-blocked") {
    return [
      "agentq accept-blocked",
      command.summary,
      "",
      "Usage:",
      "  agentq accept-blocked <message-id> --actor <sender-id> --to <blocked-recipient-id> --evidence \"...\""
    ].join("\n");
  }

  if (command.name === "done-check") {
    return [
      "agentq done-check",
      command.summary,
      "",
      "Usage:",
      "  agentq done-check --actor <id>"
    ].join("\n");
  }

  if (command.name === "scope-check") {
    return [
      "agentq scope-check",
      command.summary,
      "",
      "Usage:",
      "  agentq scope-check --actor <id>",
      "",
      "Fails when the actor still advertises broad `.` paths or generic hook responsibilities."
    ].join("\n");
  }

  if (command.name === "actors") {
    return [
      "agentq actors",
      command.summary,
      "",
      "Usage:",
      "  agentq actors [--stale-ms <milliseconds>]",
      "",
      "Actors are marked stale when lastSeen is older than 1 hour by default.",
      "Active means recent AgentQ presence, not a guaranteed live OS process."
    ].join("\n");
  }

  if (command.name === "doctor") {
    return [
      "agentq doctor",
      command.summary,
      "",
      "Usage:",
      "  agentq doctor"
    ].join("\n");
  }

  if (command.name === "hook") {
    return [
      "agentq hook",
      command.summary,
      "",
      "Usage:",
      "  agentq hook <codex|claude-code|copilot-cli> <session-start|pre-tool|stop>",
      "",
      "Hooks read a JSON payload from stdin. Manual smoke example:",
      "  echo {\"session_id\":\"smoke\",\"cwd\":\"<workspace>\"} | agentq hook codex session-start"
    ].join("\n");
  }

  return [
    `agentq ${command.name}`,
    command.summary,
    "",
    "Usage for this command has not been documented."
  ].join("\n");
}

export async function runCommand(
  argv: readonly string[],
  runtime: CommandRuntime = {
    cwd: process.cwd(),
    env: process.env,
    now: () => new Date().toISOString(),
    deliveryMode: "execute"
  }
): Promise<CommandResult> {
  const command = argv[0];

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { code: 0, stdout: `${renderHelp()}\n`, stderr: "" };
  }

  const commandSpec = COMMANDS.find((candidate) => candidate.name === command);
  if (commandSpec === undefined) {
    return { code: 2, stdout: "", stderr: `agentq: unknown command: ${command}\n` };
  }

  if (argv[1] === "--help" || argv[1] === "-h") {
    return { code: 0, stdout: `${renderCommandHelp(commandSpec)}\n`, stderr: "" };
  }

  if (command === "enter") {
    return await enterCommand(argv.slice(1), runtime);
  }

  if (command === "install") {
    return await installCommand(argv.slice(1), runtime);
  }

  if (command === "uninstall") {
    return await uninstallCommand(argv.slice(1), runtime);
  }

  if (command === "doctor") {
    return await doctorCommand(runtime);
  }

  if (command === "hook") {
    return await hookCommand(argv.slice(1), runtime);
  }

  if (command === "block") {
    return await blockCommand(argv.slice(1), runtime);
  }

  if (command === "question") {
    return await questionCommand(argv.slice(1), runtime);
  }

  if (command === "actors") {
    return await actorsCommand(argv.slice(1), runtime);
  }

  if (command === "work") {
    return await workCommand(argv.slice(1), runtime);
  }

  if (command === "inbox") {
    return await inboxCommand(argv.slice(1), runtime);
  }

  if (command === "wake") {
    return await runWakeCommand(argv.slice(1), runtime);
  }

  if (command === "respond") {
    return await respondCommand(argv.slice(1), runtime);
  }

  if (command === "supersede") {
    return await supersedeCommand(argv.slice(1), runtime);
  }

  if (command === "follow-up") {
    return await followUpCommand(argv.slice(1), runtime);
  }

  if (command === "accept-blocked") {
    return await acceptBlockedCommand(argv.slice(1), runtime);
  }

  if (command === "done-check") {
    return await doneCheckCommand(argv.slice(1), runtime);
  }

  if (command === "scope-check") {
    return await scopeCheckCommand(argv.slice(1), runtime);
  }

  return {
    code: 2,
    stdout: "",
    stderr: `agentq: command dispatch missing for registered command: ${command}\n`
  };
}

async function actorsCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const staleAfterMs = Number(optionValue(args, "stale-ms") ?? String(DEFAULT_ACTOR_STALE_AFTER_MS));
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("actors --stale-ms must be a non-negative number.");
  }
  const store = await openStore(runtime);
  const actors = await listActorPresences(store);
  if (actors.length === 0) {
    return {
      code: 0,
      stdout: "no actors\n",
      stderr: ""
    };
  }

  const nowMs = Date.parse(runtime.now());
  const summaries = actors.map((actor) => actorStatus(actor, nowMs, staleAfterMs));
  const activeCount = summaries.filter((summary) => summary.status === "active").length;
  const staleCount = summaries.length - activeCount;

  return {
    code: 0,
    stdout: [
      `actors: ${actors.length} (active ${activeCount}, stale ${staleCount}, staleAfter ${formatDuration(staleAfterMs)})`,
      "",
      summaries.map(renderActorPresence).join("\n\n")
    ].join("\n") + "\n",
    stderr: ""
  };
}

async function workCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      code: 0,
      stdout: [
        "agentq work",
        "Manage one explicit actor's internal work stack",
        "",
        "Usage:",
        "  agentq work start --actor <id> --title <title> [--path <path>...]",
        "  agentq work status --actor <id>",
        "  agentq work touch --actor <id> --path <path>...",
        "  agentq work evidence --actor <id> --evidence \"...\"",
        "  agentq work close --actor <id> --summary \"...\" [--evidence \"...\"]"
      ].join("\n") + "\n",
      stderr: ""
    };
  }

  const args = parseArgs(argv.slice(1));
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);

  if (subcommand === "start") {
    const workId = optionValue(args, "id");
    const goal = optionValue(args, "goal");
    const state = await startWork(store, {
      actorId,
      title: requiredOption(args, "title"),
      paths: optionValues(args, "path").length > 0 ? optionValues(args, "path") : ["."],
      now: runtime.now(),
      ...(workId === undefined ? {} : { workId }),
      ...(goal === undefined ? {} : { goal }),
      ...(args.flags.has("root") ? { parentWorkId: null } : {})
    });
    return {
      code: 0,
      stdout: renderWorkState("started", state),
      stderr: ""
    };
  }

  if (subcommand === "status") {
    const state = await readActiveWorkState(store, actorId);
    return {
      code: 0,
      stdout: state === null ? `no active work for ${actorId}\n` : renderWorkState("active", state),
      stderr: ""
    };
  }

  if (subcommand === "touch") {
    const state = await appendActiveWorkTouch(store, {
      actorId,
      paths: optionValues(args, "path"),
      now: runtime.now()
    });
    if (state === null) {
      return {
        code: 2,
        stdout: "",
        stderr: `agentq: no active work for ${actorId}\n`
      };
    }

    return {
      code: 0,
      stdout: renderWorkState("touched", state),
      stderr: ""
    };
  }

  if (subcommand === "evidence") {
    const state = await appendWorkEvidence(store, {
      actorId,
      evidence: optionValues(args, "evidence"),
      now: runtime.now()
    });
    return {
      code: 0,
      stdout: renderWorkState("evidence", state),
      stderr: ""
    };
  }

  if (subcommand === "close") {
    const state = await closeWork(store, {
      actorId,
      summary: requiredOption(args, "summary"),
      evidence: optionValues(args, "evidence"),
      now: runtime.now()
    });
    return {
      code: 0,
      stdout: renderWorkState("closed", state),
      stderr: ""
    };
  }

  return {
    code: 2,
    stdout: "",
    stderr: `agentq: unknown work command: ${subcommand}\n`
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const result = await runCommand(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

async function installCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const mutate = args.flags.has("yes");
  const plan = mutate
    ? await applyMarkerInstall(runtime.cwd)
    : await planMarkerInstall(runtime.cwd);
  const hookPlan = mutate
    ? await applyHookConfigInstall(runtime.cwd)
    : await planHookConfigInstall(runtime.cwd);

  return {
    code: 0,
    stdout: renderInstallPlan(mutate ? "install" : "install dry-run", plan, hookPlan, mutate),
    stderr: ""
  };
}

async function uninstallCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const mutate = args.flags.has("yes");
  const plan = mutate
    ? await applyMarkerUninstall(runtime.cwd)
    : await planMarkerUninstall(runtime.cwd);
  const hookPlan = mutate
    ? await applyHookConfigUninstall(runtime.cwd)
    : await planHookConfigUninstall(runtime.cwd);

  return {
    code: 0,
    stdout: renderInstallPlan(mutate ? "uninstall" : "uninstall dry-run", plan, hookPlan, mutate),
    stderr: ""
  };
}

async function doctorCommand(runtime: CommandRuntime): Promise<CommandResult> {
  const report = await runDoctor(runtime.cwd, { env: runtime.env });

  return {
    code: report.summary === "fail" ? 2 : 0,
    stdout: renderDoctorReport(report),
    stderr: ""
  };
}

async function hookCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const adapter = argv[0] as HookAdapter | undefined;
  const event = argv[1] as HookRuntimeEvent | undefined;
  if (adapter === undefined || event === undefined) {
    throw new Error("hook requires <adapter> <event>");
  }

  const stdin = await readStdin();
  if (stdin.trim().length === 0) {
    return {
      code: 2,
      stdout: "",
      stderr: "agentq: hook requires JSON payload on stdin with cwd and session_id/sessionId. Example: echo {\"session_id\":\"smoke\",\"cwd\":\"<workspace>\"} | agentq hook codex session-start\n"
    };
  }
  const payload = JSON.parse(stdin);
  return await runHookHandler({
    adapter,
    event,
    payload,
    env: runtime.env,
    now: runtime.now()
  });
}

async function enterCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const paths = optionValues(args, "paths");
  const responsibilities = optionValues(args, "responsibility");
  const store = await openStore(runtime);
  const actorId = optionValue(args, "actor");
  if (actorId !== undefined) {
    const summary = optionValue(args, "summary");
    const presence = await refreshActorPresence(store, {
      actorId,
      cwd: runtime.cwd,
      activePaths: paths,
      responsibilities,
      now: runtime.now(),
      ...(summary === undefined ? {} : { summary })
    });

    return {
      code: 0,
      stdout: `${presence.actorId} refreshed\n`,
      stderr: ""
    };
  }

  const adapter = requiredOption(args, "as") as AgentKind;
  const sessionId = optionValue(args, "session") ?? `${adapter}-manual`;
  const summary = optionValue(args, "summary") ?? responsibilities[0] ?? `${adapter} actor`;
  const handle = optionValue(args, "handle");
  const bindingInput = {
    adapter,
    sessionId,
    cwd: runtime.cwd,
    activePaths: paths.length > 0 ? paths : ["."],
    responsibilities: responsibilities.length > 0 ? responsibilities : [summary],
    summary,
    now: runtime.now()
  };
  const binding = await createOrRefreshSessionBinding(
    store,
    handle === undefined ? bindingInput : { ...bindingInput, handle }
  );

  return {
    code: 0,
    stdout: `${binding.actorId} registered\n`,
    stderr: ""
  };
}

async function blockCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const store = await openStore(runtime);
  const id = optionValue(args, "id") ?? `AQ-${Date.now()}`;
  const to = optionValues(args, "to");
  const summary = requiredOption(args, "summary");
  const paths = optionValues(args, "path");
  const contracts = optionValues(args, "contract");
  const message: Message = {
    id,
    kind: "blocker",
    createdBy: requiredOption(args, "actor"),
    summary,
    paths: paths.length > 0 ? paths : ["."],
    contracts,
    passCriteria: optionValues(args, "pass").length > 0 ? optionValues(args, "pass") : ["recipient responds"],
    observed: optionValue(args, "observed") ?? summary,
    brokenContract: optionValue(args, "contract-broken") ?? "required handoff must be answered"
  };
  const routeInput = {
    message,
    now: runtime.now(),
    staleAfterMs: Number(optionValue(args, "stale-ms") ?? String(DEFAULT_ACTOR_STALE_AFTER_MS))
  };
  const plan = await createRoutedBlocker(
    store,
    to.length === 0 ? routeInput : { ...routeInput, explicitTo: to }
  );
  const delivery = await deliverRoutedRequests(store, plan, runtime);

  return {
    code: 0,
    stdout: renderRoutedDelivery(id, plan.recipients.map((recipient) => recipient.actorId), delivery),
    stderr: ""
  };
}

async function questionCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const store = await openStore(runtime);
  const id = optionValue(args, "id") ?? `AQ-${Date.now()}`;
  const to = optionValues(args, "to");
  const question = requiredOption(args, "question");
  const paths = optionValues(args, "path");
  const contracts = optionValues(args, "contract");
  if (paths.length === 0 && contracts.length === 0) {
    throw new Error("question requires --path or --contract so recipients can judge relevance.");
  }
  const expectedAnswer = optionValue(args, "expect");
  const passCriteria = optionValues(args, "pass");
  const message: Message = {
    id,
    kind: "question",
    createdBy: requiredOption(args, "actor"),
    summary: optionValue(args, "summary") ?? question,
    paths,
    contracts,
    passCriteria: passCriteria.length > 0
      ? passCriteria
      : [expectedAnswer ?? "recipient answers with evidence"],
    question,
    ...(expectedAnswer === undefined ? {} : { expectedAnswer })
  };
  const routeInput = {
    message,
    now: runtime.now(),
    staleAfterMs: Number(optionValue(args, "stale-ms") ?? String(DEFAULT_ACTOR_STALE_AFTER_MS))
  };
  const plan = await createRoutedRequest(
    store,
    to.length === 0 ? routeInput : { ...routeInput, explicitTo: to }
  );
  const delivery = await deliverRoutedRequests(store, plan, runtime);

  return {
    code: 0,
    stdout: renderRoutedDelivery(id, plan.recipients.map((recipient) => recipient.actorId), delivery),
    stderr: ""
  };
}

function renderRoutedDelivery(
  messageId: string,
  recipientActorIds: readonly string[],
  delivery: DeliveryReport
): string {
  return [
    `${messageId} routed to ${recipientActorIds.join(", ")}`,
    renderDeliveryReport(delivery)
  ].join("\n") + "\n";
}

async function inboxCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);
  const openRequests = await listPendingInboxItems(store, actorId);

  return {
    code: 0,
    stdout: openRequests.length === 0
      ? "inbox empty\n"
      : `${openRequests.map((item) => renderInboxRequest(actorId, item.state, item.request)).join("\n\n")}\n`,
    stderr: ""
  };
}

function renderInboxRequest(
  actorId: string,
  state: FoldedMessageState,
  request: FoldedRequest
): string {
  const message = state.message;
  const responseStatus = message.kind === "question" ? "answered" : "resolved";
  const lines = [
    message.id,
    `  kind: ${message.kind}`,
    `  from: ${message.createdBy}`,
    `  summary: ${message.summary}`,
    `  paths: ${joinList(message.paths)}`,
    `  contracts: ${joinList(message.contracts)}`
  ];

  if (message.kind === "question") {
    lines.push(`  question: ${message.question}`);
    if (message.expectedAnswer !== undefined) {
      lines.push(`  expected: ${message.expectedAnswer}`);
    }
  } else {
    lines.push(`  observed: ${message.observed}`);
    lines.push(`  broken: ${message.brokenContract}`);
  }

  lines.push(`  pass: ${joinList(message.passCriteria)}`);
  lines.push(`  routing: ${request.request.routingEvidence.map((evidence) => `${evidence.kind}:${evidence.detail}`).join("; ")}`);
  lines.push(`  respond: agentq respond ${message.id} --actor ${actorId} --status ${responseStatus} --evidence "..."`);

  return lines.join("\n");
}

function joinList(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

async function respondCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const messageId = args.positionals[0];
  if (messageId === undefined) {
    throw new Error("respond requires a message id");
  }

  const store = await openStore(runtime);
  const actorId = requiredOption(args, "actor");
  const status = requiredOption(args, "status") as ResponseStatus;
  const evidence = requiredOption(args, "evidence");
  const eventId = optionValue(args, "event") ?? `EV-${Date.now()}`;
  const state = await foldMessageState(store, messageId);
  requirePendingInboundRequest(state, messageId, actorId);
  const event = {
    kind: "response",
    id: eventId,
    messageId,
    actorId,
    status,
    evidence: [evidence],
    at: runtime.now()
  };
  EventSchema.parse(event);
  await writeOnceYaml(store.layout.eventPath(messageId, eventId), event);

  return {
    code: 0,
    stdout: `${messageId} ${status}\n`,
    stderr: ""
  };
}

async function supersedeCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const messageId = args.positionals[0];
  if (messageId === undefined) {
    throw new Error("supersede requires a message id");
  }

  const store = await openStore(runtime);
  const actorId = requiredOption(args, "actor");
  const targetActorId = requiredOption(args, "to");
  const evidence = requiredOption(args, "evidence");
  const eventId = optionValue(args, "event") ?? `EV-${Date.now()}`;
  const state = await foldMessageState(store, messageId);
  requirePendingOutboundRequest(state, messageId, actorId, targetActorId);
  const event = {
    kind: "supersede",
    id: eventId,
    messageId,
    actorId,
    targetActorId,
    evidence: [evidence],
    at: runtime.now()
  };
  EventSchema.parse(event);
  await writeOnceYaml(store.layout.eventPath(messageId, eventId), event);

  return {
    code: 0,
    stdout: `${messageId} superseded for ${targetActorId}\n`,
    stderr: ""
  };
}

async function followUpCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  return await writeBlockedFollowUpEvent("follow_up", argv, runtime);
}

async function acceptBlockedCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  return await writeBlockedFollowUpEvent("accept_blocked", argv, runtime);
}

async function writeBlockedFollowUpEvent(
  kind: "follow_up" | "accept_blocked",
  argv: readonly string[],
  runtime: CommandRuntime
): Promise<CommandResult> {
  const args = parseArgs(argv);
  const messageId = args.positionals[0];
  if (messageId === undefined) {
    throw new Error(`${kind === "follow_up" ? "follow-up" : "accept-blocked"} requires a message id`);
  }

  const store = await openStore(runtime);
  const actorId = requiredOption(args, "actor");
  const blockedActorId = requiredOption(args, "to");
  const evidence = requiredOption(args, "evidence");
  const eventId = optionValue(args, "event") ?? `EV-${Date.now()}`;
  const state = await foldMessageState(store, messageId);
  requireBlockedOutboundRequest(state, messageId, actorId, blockedActorId);
  const event = {
    kind,
    id: eventId,
    messageId,
    actorId,
    blockedActorId,
    evidence: [evidence],
    at: runtime.now()
  };
  EventSchema.parse(event);
  await writeOnceYaml(store.layout.eventPath(messageId, eventId), event);

  return {
    code: 0,
    stdout: `${messageId} ${kind === "follow_up" ? "followed up" : "accepted blocked"} for ${blockedActorId}\n`,
    stderr: ""
  };
}

function requirePendingInboundRequest(
  state: FoldedMessageState,
  messageId: string,
  actorId: string
): FoldedRequest {
  const request = state.requests.find((candidate) => candidate.request.to === actorId);
  if (request === undefined) {
    throw new Error(`AgentQ message ${messageId} has no required request for ${actorId}.`);
  }
  if (request.status !== "pending") {
    throw new Error(`AgentQ request ${messageId} for ${actorId} is already ${request.status}.`);
  }

  return request;
}

function requirePendingOutboundRequest(
  state: FoldedMessageState,
  messageId: string,
  senderActorId: string,
  targetActorId: string
): FoldedRequest {
  requireMessageSender(state, messageId, senderActorId);
  const request = state.requests.find((candidate) => candidate.request.to === targetActorId);
  if (request === undefined) {
    throw new Error(`AgentQ message ${messageId} has no required request for ${targetActorId}.`);
  }
  if (request.status !== "pending") {
    throw new Error(`AgentQ request ${messageId} for ${targetActorId} is already ${request.status}.`);
  }

  return request;
}

function requireBlockedOutboundRequest(
  state: FoldedMessageState,
  messageId: string,
  senderActorId: string,
  blockedActorId: string
): FoldedRequest {
  requireMessageSender(state, messageId, senderActorId);
  const request = state.requests.find((candidate) => candidate.request.to === blockedActorId);
  if (request === undefined) {
    throw new Error(`AgentQ message ${messageId} has no required request for ${blockedActorId}.`);
  }
  if (request.status !== "blocked") {
    throw new Error(`AgentQ request ${messageId} for ${blockedActorId} is ${request.status}, not blocked.`);
  }

  return request;
}

function requireMessageSender(
  state: FoldedMessageState,
  messageId: string,
  actorId: string
): void {
  if (state.message.createdBy !== actorId) {
    throw new Error(`AgentQ message ${messageId} was created by ${state.message.createdBy}, not ${actorId}.`);
  }
}

async function doneCheckCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);
  const result = await runDoneCheck(store, actorId);
  const decision = planStopContinuation(result, args.flags.has("stop-hook-active"));

  if (!result.ok) {
    return {
      code: 2,
      stdout: "",
      stderr: `${decision.reason}\n`
    };
  }

  const workResult = await runWorkDoneCheck(store, actorId);
  if (!workResult.ok) {
    return {
      code: 2,
      stdout: "",
      stderr: `${planWorkStopContinuation(workResult)}\n`
    };
  }

  const scopeResult = await runScopeCheck(store, actorId);
  if (!scopeResult.ok) {
    return {
      code: 2,
      stdout: "",
      stderr: `${planScopeContinuation(scopeResult)}\n`
    };
  }

  return {
    code: 0,
    stdout: "ok: no required replies or active work remain open\n",
    stderr: ""
  };
}

async function scopeCheckCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);
  const result = await runScopeCheck(store, actorId);
  if (!result.ok) {
    return {
      code: 2,
      stdout: "",
      stderr: `${planScopeContinuation(result)}\n`
    };
  }

  return {
    code: 0,
    stdout: "ok: actor scope is specific\n",
    stderr: ""
  };
}

async function openStore(runtime: CommandRuntime) {
  const store = await resolveWorkspaceStore(runtime.cwd, {
    env: runtime.env
  });
  await ensureWorkspaceStore(store);
  return store;
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

function optionValues(args: ParsedArgs, name: string): string[] {
  return [...(args.options.get(name) ?? [])];
}

function renderInstallPlan(
  title: string,
  plan: MarkerPlan,
  hookPlan: HookConfigPlan,
  mutated: boolean
): string {
  const lines = [
    `AgentQ ${title}`,
    `Workspace: ${plan.workspaceRoot}`,
    mutated ? "Mode: files were updated" : "Mode: no files written; rerun with --yes to apply",
    "",
    "Files:",
    ...plan.entries.map(
      (entry) => `  ${displayMarkerAction(entry).padEnd(9)} ${entry.relativePath} - ${entry.label}`
    ),
    "",
    "Hook files:",
    ...hookPlan.entries.map(
      (entry) => `  ${entry.action.padEnd(9)} ${entry.relativePath} - ${entry.label}`
    ),
    "",
    "Hook commands:",
    "  agentq hook codex session-start",
    "  agentq hook codex pre-tool",
    "  agentq hook codex stop",
    "  agentq hook claude-code session-start",
    "  agentq hook claude-code pre-tool",
    "  agentq hook claude-code stop",
    "  agentq hook copilot-cli session-start",
    "  agentq hook copilot-cli pre-tool",
    "  agentq hook copilot-cli stop",
    "",
    `Rollback: ${plan.uninstallCommand}`,
    "",
    "Commit guidance:",
    ...plan.commitGuidance.map((guidance) => `  ${guidance}`)
  ];

  return `${lines.join("\n")}\n`;
}

function displayMarkerAction(entry: MarkerPlan["entries"][number]): string {
  if (entry.action === "create" && entry.beforeExists) {
    return "insert";
  }

  return entry.action;
}

interface ActorStatusSummary {
  readonly actor: Presence;
  readonly status: "active" | "stale";
  readonly ageMs: number | null;
}

function actorStatus(actor: Presence, nowMs: number, staleAfterMs: number): ActorStatusSummary {
  const lastSeenMs = Date.parse(actor.lastSeen);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(lastSeenMs)
    ? Math.max(0, nowMs - lastSeenMs)
    : null;
  return {
    actor,
    status: ageMs !== null && ageMs <= staleAfterMs ? "active" : "stale",
    ageMs
  };
}

function renderActorPresence(summary: ActorStatusSummary): string {
  const actor = summary.actor;
  const lines = [
    actor.actorId,
    `  kind: ${actor.kind}`,
    `  status: ${summary.status}`,
    `  age: ${summary.ageMs === null ? "unknown" : formatDuration(summary.ageMs)}`,
    `  lastSeen: ${actor.lastSeen}`,
    `  paths: ${actor.activePaths.join(", ")}`,
    `  responsibilities: ${actor.responsibilities.join(", ")}`
  ];
  const warning = routingScopeWarning(actor);
  if (warning !== null) {
    lines.push(`  routing: ${warning}`);
  }

  return lines.join("\n");
}

function routingScopeWarning(actor: Presence): string | null {
  const weaknesses = actorScopeWeaknesses(actor);
  if (weaknesses.length === 0) {
    return null;
  }

  return `broad; refresh this actor with agentq enter --actor ${actor.actorId} --paths <path> --responsibility "<owned area>"`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function renderWorkState(label: string, work: WorkState): string {
  const lines = [
    `${label}: ${work.workId}`,
    `  actor: ${work.actorId}`,
    `  status: ${work.status}`,
    `  title: ${work.title}`,
    `  touched: ${work.touchedPaths.join(", ")}`,
    `  evidence: ${work.evidence.length}`
  ];
  if (work.parentWorkId !== null) {
    lines.push(`  parent: ${work.parentWorkId}`);
  }
  if (work.closeSummary !== null) {
    lines.push(`  summary: ${work.closeSummary}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    `AgentQ doctor: ${report.summary}`,
    `Workspace: ${report.workspaceRoot}`,
    `Runtime store: ${report.storePath}`,
    "",
    "Checks:",
    ...report.checks.flatMap((check) => {
      const rendered = [`  ${check.level.padEnd(4)} ${check.name} - ${check.detail}`];
      if (check.remediation !== undefined) {
        rendered.push(`       fix: ${check.remediation}`);
      }

      return rendered;
    })
  ];

  return `${lines.join("\n")}\n`;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function isCliEntrypoint(argvPath: string | undefined): boolean {
  if (argvPath === undefined) {
    return false;
  }

  return pathToFileURL(realpathSync(argvPath)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
}

if (isCliEntrypoint(process.argv[1])) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`agentq: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
