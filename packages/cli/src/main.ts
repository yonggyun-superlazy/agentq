#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
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
  createRoutedNote,
  createRoutedRequest,
  ensureWorkspaceStore,
  EventSchema,
  findActivePathOwners,
  findActiveResourceOwners,
  foldMessageState,
  closeWork,
  applyMarkerInstall,
  applyMarkerUninstall,
  listMessageIdsFromStore,
  listInboxItems,
  listPendingInboxItems,
  listActorPresences,
  readDiagnosticEvents,
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
  type ActivePathOwnerMatch,
  type ActiveResourceOwnerMatch,
  type DiagnosticEvent,
  type FoldedMessageState,
  type FoldedRequest,
  type Message,
  type Presence,
  type ResponseStatus,
  type WorkState,
  type WorkTerminalStatus
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
}

const DEFAULT_ACTOR_STALE_AFTER_MS = 3_600_000;

export const COMMANDS: readonly CommandSpec[] = [
  { name: "install", summary: "Install agent instructions and hook gates" },
  { name: "doctor", summary: "Explain AgentQ workspace and hook state" },
  { name: "status", summary: "Summarize workspace AgentQ health" },
  { name: "uninstall", summary: "Remove AgentQ-owned integration markers and hook gates" },
  { name: "actors", summary: "List workspace actors by recent presence" },
  { name: "owners", summary: "Find active actors responsible for paths or resources" },
  { name: "enter", summary: "Register actor presence and responsibilities" },
  { name: "work", summary: "Manage one explicit actor's internal work stack" },
  { name: "block", summary: "Create a required-response blocker" },
  { name: "question", summary: "Ask an actor a required-response question" },
  { name: "note", summary: "Send a non-blocking inbox note" },
  { name: "inbox", summary: "Show inbox requests and notes for an explicit actor" },
  { name: "wake", summary: "Inspect pending delivery targets" },
  { name: "diag", summary: "Show recent AgentQ diagnostic ring log entries" },
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
      "  agentq work start --actor <id> --title <title> --path <path>... [--resource <resource>...]",
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
      "  agentq enter --actor <id> [--paths <path>...] [--resource <resource>...] [--responsibility <text>...] [--summary <text>]",
      "  agentq enter --as <codex|claude-code|copilot-cli|custom> [--session <id>] [--paths <path>...] [--resource <resource>...] [--responsibility <text>...]",
      "",
      "Use --actor with the hook-provided actor id to refresh that exact actor. Use --as only to create or refresh a manual session binding."
    ].join("\n");
  }

  if (command.name === "owners") {
    return [
      "agentq owners",
      command.summary,
      "",
      "Usage:",
      "  agentq owners --path <path>... [--resource <resource>...] [--actor <id>] [--stale-ms <milliseconds>]",
      "  agentq owners --resource <resource>... [--actor <id>] [--stale-ms <milliseconds>]",
      "",
      "Use resources for soft-exclusive tools such as setup-watcher:ProjectDD/DDSetup or unity:ProjectDD/DDUnity."
    ].join("\n");
  }

  if (command.name === "block") {
    return [
      "agentq block",
      command.summary,
      "",
      "Usage:",
      "  agentq block --actor <id> --summary \"...\" [--to <id>...] [--id <id>] [--path <path>...] [--resource <resource>...] [--contract <name>...] [--pass \"...\"]",
      "",
      "If --to is omitted, AgentQ routes to active actors matched by path, resource, or contract.",
      "After routing, AgentQ records pending delivery without starting headless agent processes."
    ].join("\n");
  }

  if (command.name === "question") {
    return [
      "agentq question",
      command.summary,
      "",
      "Usage:",
      "  agentq question --actor <id> --question \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --path <path>... [--resource <resource>...] [--contract <name>...] [--expect \"...\"] [--pass \"...\"]",
      "  agentq question --actor <id> --question \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --resource <resource>... [--expect \"...\"] [--pass \"...\"]",
      "  agentq question --actor <id> --question \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --contract <name>... [--expect \"...\"] [--pass \"...\"]",
      "",
      "Questions are required requests. The sender remains blocked until routed actors answer.",
      "After routing, AgentQ records pending delivery without starting headless agent processes."
    ].join("\n");
  }

  if (command.name === "note") {
    return [
      "agentq note",
      command.summary,
      "",
      "Usage:",
      "  agentq note --actor <id> --note \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --path <path>... [--resource <resource>...] [--contract <name>...]",
      "  agentq note --actor <id> --note \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --resource <resource>...",
      "  agentq note --actor <id> --note \"...\" [--to <id>...] [--id <id>] [--summary \"...\"] --contract <name>...",
      "",
      "Notes are non-blocking inbox items. Use question or block when the sender must wait for a reply."
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
      "Shows each pending request or note with sender, summary, routing context, and the response/ack command."
    ].join("\n");
  }

  if (command.name === "wake") {
    return [
      "agentq wake",
      command.summary,
      "",
      "Usage:",
      "  agentq wake list",
      "  agentq wake --actor <id>",
      "  agentq wake --all",
      "",
      "Wake is inspection-only. It never starts headless resume processes.",
      "Use the listed inbox command in the visible target agent TUI."
    ].join("\n");
  }

  if (command.name === "diag") {
    return [
      "agentq diag",
      command.summary,
      "",
      "Usage:",
      "  agentq diag [--limit <count>]",
      "  agentq diag activity [--window <duration>] [--limit <count>]",
      "",
      "Shows bounded OS-local hook diagnostics such as inferred paths/resources, ignored AgentQ meta commands, and nudge decisions.",
      "Activity groups recent diagnostics by actor so stale-window policy can be based on observed hook gaps."
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

  if (command.name === "status") {
    return [
      "agentq status",
      command.summary,
      "",
      "Usage:",
      "  agentq status [--stale-ms <milliseconds>]",
      "",
      "Shows doctor summary, active/stale actors, routeable actors, recent messages, pending inbox requests, open work, and weak scope counts."
    ].join("\n");
  }

  if (command.name === "owners") {
    return [
      "agentq owners",
      command.summary,
      "",
      "Usage:",
      "  agentq owners --path <path>... [--actor <id>] [--stale-ms <milliseconds>]",
      "",
      "Shows active actors whose specific path scope overlaps the provided path. Use --actor to exclude yourself."
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
    now: () => new Date().toISOString()
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

  if (command === "status") {
    return await statusCommand(argv.slice(1), runtime);
  }

  if (command === "owners") {
    return await ownersCommand(argv.slice(1), runtime);
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

  if (command === "note") {
    return await noteCommand(argv.slice(1), runtime);
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

  if (command === "diag") {
    return await diagCommand(argv.slice(1), runtime);
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
        "  agentq work start --actor <id> --title <title> --path <path>...",
        "  agentq work status --actor <id>",
        "  agentq work touch --actor <id> --path <path>...",
        "  agentq work evidence --actor <id> --evidence \"...\"",
        "  agentq work close --actor <id> --summary \"...\" [--evidence \"...\"] [--status closed|abandoned|superseded]"
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
    const activeResources = optionValues(args, "resource");
    const paths = requiredSpecificPathOptions(args, "path", "work start");
    const state = await startWork(store, {
      actorId,
      title: requiredOption(args, "title"),
      paths,
      now: runtime.now(),
      ...(workId === undefined ? {} : { workId }),
      ...(goal === undefined ? {} : { goal }),
      ...(args.flags.has("root") ? { parentWorkId: null } : {})
    });
    await refreshActorPresence(store, {
      actorId,
      cwd: runtime.cwd,
      activePaths: state.paths,
      activeResources,
      responsibilities: [state.title],
      summary: state.title,
      now: runtime.now()
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
      paths: pathOptionValues(args, "path"),
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
    const status = parseWorkTerminalStatus(optionValue(args, "status"));
    const state = await closeWork(store, {
      actorId,
      summary: requiredOption(args, "summary"),
      evidence: optionValues(args, "evidence"),
      ...(status === undefined ? {} : { status }),
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

async function statusCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const staleAfterMs = Number(optionValue(args, "stale-ms") ?? String(DEFAULT_ACTOR_STALE_AFTER_MS));
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("status --stale-ms must be a non-negative number.");
  }

  const store = await openStore(runtime);
  const report = await runDoctor(runtime.cwd, { env: runtime.env });
  const actors = await listActorPresences(store);
  const now = runtime.now();
  const nowMs = Date.parse(now);
  const details = await Promise.all(
    actors.map(async (actor) => {
      const summary = actorStatus(actor, nowMs, staleAfterMs);
      const [pendingInbox, activeWork] = await Promise.all([
        listPendingInboxItems(store, actor.actorId),
        readActiveWorkState(store, actor.actorId)
      ]);
      return {
        summary,
        pendingInbox,
        activeWork,
        weaknesses: actorScopeWeaknesses(actor)
      };
    })
  );
  const recentMessages = await listRecentMessageSummaries(store, nowMs, 86_400_000);

  return {
    code: report.summary === "fail" ? 2 : 0,
    stdout: renderWorkspaceStatus(report, details, staleAfterMs, recentMessages),
    stderr: ""
  };
}

async function ownersCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const staleAfterMs = Number(optionValue(args, "stale-ms") ?? String(DEFAULT_ACTOR_STALE_AFTER_MS));
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("owners --stale-ms must be a non-negative number.");
  }

  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  if (paths.length === 0 && resources.length === 0) {
    throw new Error("owners requires --path <path> or --resource <resource>.");
  }

  const store = await openStore(runtime);
  const actorId = optionValue(args, "actor");
  const pathMatches = await findActivePathOwners(store, {
    paths,
    now: runtime.now(),
    staleAfterMs,
    ...(actorId === undefined ? {} : { actorId })
  });
  const resourceMatches = await findActiveResourceOwners(store, {
    resources,
    now: runtime.now(),
    staleAfterMs,
    ...(actorId === undefined ? {} : { actorId })
  });

  return {
    code: 0,
    stdout: renderOwners(paths, resources, pathMatches, resourceMatches),
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

async function diagCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  if (argv[0] === "activity") {
    return await diagActivityCommand(argv.slice(1), runtime);
  }

  const args = parseArgs(argv);
  const limit = Number(optionValue(args, "limit") ?? "20");
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("diag --limit must be a positive integer.");
  }

  const store = await openStore(runtime);
  const events = await readDiagnosticEvents(store, limit);
  return {
    code: 0,
    stdout: renderDiagnosticEvents(events),
    stderr: ""
  };
}

async function diagActivityCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const windowMs = parseDurationOption(optionValue(args, "window") ?? "24h", "diag activity --window");
  const limit = Number(optionValue(args, "limit") ?? "20");
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("diag activity --limit must be a positive integer.");
  }

  const store = await openStore(runtime);
  const nowMs = Date.parse(runtime.now());
  const ringEvents = await readDiagnosticEvents(store, 10_000);
  const windowEvents = ringEvents.filter((event) => {
    const atMs = Date.parse(event.at);
    return event.actorId !== undefined &&
      Number.isFinite(atMs) &&
      Number.isFinite(nowMs) &&
      nowMs - atMs >= 0 &&
      nowMs - atMs <= windowMs;
  });
  const actors = await listActorPresences(store);
  const rows = await buildDiagnosticActivityRows(store, actors, windowEvents, nowMs, windowMs);

  return {
    code: 0,
    stdout: renderDiagnosticActivity(rows.slice(0, limit), {
      windowMs,
      eventCount: windowEvents.length,
      rowCount: rows.length,
      limit
    }),
    stderr: ""
  };
}

async function enterCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const paths = pathOptionValues(args, "paths");
  const activeResources = optionValues(args, "resource");
  const responsibilities = optionValues(args, "responsibility");
  const store = await openStore(runtime);
  const actorId = optionValue(args, "actor");
  if (actorId !== undefined) {
    const summary = optionValue(args, "summary");
    const presence = await refreshActorPresence(store, {
      actorId,
      cwd: runtime.cwd,
      activePaths: paths,
      activeResources,
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
    ...(activeResources.length === 0 ? {} : { activeResources }),
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
  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  const contracts = optionValues(args, "contract");
  const message: Message = {
    id,
    kind: "blocker",
    createdBy: requiredOption(args, "actor"),
    summary,
    paths: paths.length > 0 ? paths : ["."],
    ...(resources.length === 0 ? {} : { resources }),
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
  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  const contracts = optionValues(args, "contract");
  if (paths.length === 0 && resources.length === 0 && contracts.length === 0) {
    throw new Error("question requires --path, --resource, or --contract so recipients can judge relevance.");
  }
  const expectedAnswer = optionValue(args, "expect");
  const passCriteria = optionValues(args, "pass");
  const message: Message = {
    id,
    kind: "question",
    createdBy: requiredOption(args, "actor"),
    summary: optionValue(args, "summary") ?? question,
    paths,
    ...(resources.length === 0 ? {} : { resources }),
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

async function noteCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const store = await openStore(runtime);
  const id = optionValue(args, "id") ?? `AQ-${Date.now()}`;
  const to = optionValues(args, "to");
  const note = requiredOption(args, "note");
  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  const contracts = optionValues(args, "contract");
  if (paths.length === 0 && resources.length === 0 && contracts.length === 0) {
    throw new Error("note requires --path, --resource, or --contract so recipients can judge relevance.");
  }
  const message: Message = {
    id,
    kind: "note",
    createdBy: requiredOption(args, "actor"),
    summary: optionValue(args, "summary") ?? note,
    paths,
    ...(resources.length === 0 ? {} : { resources }),
    contracts,
    passCriteria: ["not required; acknowledge if useful"],
    body: note
  };
  const routeInput = {
    message,
    now: runtime.now(),
    staleAfterMs: Number(optionValue(args, "stale-ms") ?? String(DEFAULT_ACTOR_STALE_AFTER_MS))
  };
  const plan = await createRoutedNote(
    store,
    to.length === 0 ? routeInput : { ...routeInput, explicitTo: to }
  );

  return {
    code: 0,
    stdout: renderNonBlockingDelivery(id, plan.recipients.map((recipient) => recipient.actorId)),
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
    renderDeliveryReport(delivery),
    "next: run `agentq done-check --actor <your-actor-id>` before finishing; answered evidence will be shown there once resolved."
  ].join("\n") + "\n";
}

function renderNonBlockingDelivery(
  messageId: string,
  recipientActorIds: readonly string[]
): string {
  return [
    `${messageId} noted to ${recipientActorIds.join(", ")}`,
    "delivery:",
    ...recipientActorIds.map((actorId) => `  ${actorId}: inbox_note non_blocking`),
    "next: no reply is required; check `agentq done-check --actor <your-actor-id>` normally before finishing."
  ].join("\n") + "\n";
}

async function inboxCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);
  const openRequests = await listInboxItems(store, actorId);

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
  const action = request.request.required ? "respond" : "ack";
  const lines = [
    message.id,
    `  kind: ${message.kind}`,
    `  required: ${request.request.required ? "yes" : "no"}`,
    `  from: ${message.createdBy}`,
    `  summary: ${message.summary}`,
    `  paths: ${joinList(message.paths)}`,
    `  resources: ${joinList(message.resources ?? [])}`,
    `  contracts: ${joinList(message.contracts)}`
  ];

  if (message.kind === "question") {
    lines.push(`  question: ${message.question}`);
    if (message.expectedAnswer !== undefined) {
      lines.push(`  expected: ${message.expectedAnswer}`);
    }
  } else if (message.kind === "note") {
    lines.push(`  note: ${message.body}`);
  } else {
    lines.push(`  observed: ${message.observed}`);
    lines.push(`  broken: ${message.brokenContract}`);
  }

  if (request.request.required) {
    lines.push(`  pass: ${joinList(message.passCriteria)}`);
  }
  lines.push(`  routing: ${request.request.routingEvidence.map((evidence) => `${evidence.kind}:${evidence.detail}`).join("; ")}`);
  lines.push(`  ${action}: agentq respond ${message.id} --actor ${actorId} --status ${responseStatus} --evidence "..."`);
  lines.push(`  next: ${inboxItemNext(message.kind, request.request.required)}`);

  return lines.join("\n");
}

function inboxItemNext(kind: Message["kind"], required: boolean): string {
  if (!required) {
    return "ack if useful; this note does not block done-check.";
  }

  if (kind === "question") {
    return "answer with the requested decision/evidence so both actors can pass done-check.";
  }

  return "resolve, block with evidence, or mark not_mine/invalid; required replies block done-check.";
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
    stdout: renderDoneCheckOk(actorId, await resolvedOutboundItems(store, actorId)),
    stderr: ""
  };
}

interface ResolvedOutboundItem {
  readonly messageId: string;
  readonly to: string;
  readonly status: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly at: string;
}

async function resolvedOutboundItems(
  store: Awaited<ReturnType<typeof openStore>>,
  actorId: string
): Promise<ResolvedOutboundItem[]> {
  const messageIds = await listMessageIdsFromStore(store);
  const states = await Promise.all(messageIds.map(async (messageId) => foldMessageState(store, messageId)));
  return states
    .filter((state) => state.message.createdBy === actorId)
    .flatMap((state) =>
      state.requests.flatMap((request): ResolvedOutboundItem[] => {
        if (
          request.status === "pending" ||
          request.terminalEvent === null ||
          request.terminalEvent.kind !== "response"
        ) {
          return [];
        }

        const evidence = request.terminalEvent.evidence;
        if (evidence.length === 0) {
          return [];
        }

        return [{
          messageId: state.message.id,
          to: request.request.to,
          status: request.status,
          summary: state.message.summary,
          evidence,
          at: request.terminalEvent.at
        }];
      })
    )
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 5);
}

function renderDoneCheckOk(actorId: string, resolvedOutbound: readonly ResolvedOutboundItem[]): string {
  const lines = ["ok: no required replies or active work remain open"];
  if (resolvedOutbound.length > 0) {
    lines.push(
      "",
      "Resolved outbound replies:",
      ...resolvedOutbound.flatMap((item) => [
        `  ${item.messageId} ${item.status} by ${item.to}`,
        `    summary: ${item.summary}`,
        ...item.evidence.map((evidence) => `    evidence: ${evidence}`)
      ]),
      "",
      `next: use the answered evidence above before continuing; keep using --actor ${actorId} for AgentQ commands.`
    );
  }

  return `${lines.join("\n")}\n`;
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

function pathOptionValues(args: ParsedArgs, name: string): string[] {
  return optionValues(args, name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function requiredSpecificPathOptions(args: ParsedArgs, name: string, commandName: string): string[] {
  const paths = pathOptionValues(args, name);
  if (paths.length === 0) {
    throw new Error(`${commandName} requires --${name} <specific-path>; broad "." work is not routeable.`);
  }

  const broadPaths = paths.filter(isBroadPathOption);
  if (broadPaths.length > 0) {
    throw new Error(`${commandName} requires specific --${name} values; broad "." work is not routeable.`);
  }

  return paths;
}

function isBroadPathOption(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "." || normalized === "";
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

type PendingInboxItems = Awaited<ReturnType<typeof listPendingInboxItems>>;

interface WorkspaceStatusActor {
  readonly summary: ActorStatusSummary;
  readonly pendingInbox: PendingInboxItems;
  readonly activeWork: WorkState | null;
  readonly weaknesses: ReturnType<typeof actorScopeWeaknesses>;
}

interface RecentMessageSummary {
  readonly id: string;
  readonly kind: Message["kind"];
  readonly summary: string;
  readonly updatedAt: string;
  readonly updatedAtMs: number;
}

interface DiagnosticActivityRow {
  readonly actorId: string;
  readonly eventCount: number;
  readonly firstEventAt: string | null;
  readonly lastEventAt: string | null;
  readonly lastEventAgeMs: number | null;
  readonly maxGapMs: number | null;
  readonly p95GapMs: number | null;
  readonly avgGapMs: number | null;
  readonly lastSeenAgeMs: number | null;
  readonly pendingInboxCount: number;
  readonly hasOpenWork: boolean;
  readonly openWorkEvidenceCount: number | null;
  readonly openWorkTitle: string | null;
  readonly paths: readonly string[];
  readonly observedPaths: readonly string[];
  readonly resources: readonly string[];
  readonly summary: string | null;
}

interface DiagnosticActivityRenderInput {
  readonly windowMs: number;
  readonly eventCount: number;
  readonly rowCount: number;
  readonly limit: number;
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

function renderWorkspaceStatus(
  report: DoctorReport,
  details: readonly WorkspaceStatusActor[],
  staleAfterMs: number,
  recentMessages: readonly RecentMessageSummary[]
): string {
  const activeDetails = details.filter((detail) => detail.summary.status === "active");
  const activeCount = activeDetails.length;
  const staleCount = details.length - activeCount;
  const pendingInboxCount = details.reduce(
    (count, detail) => count + detail.pendingInbox.length,
    0
  );
  const openWorkCount = details.filter((detail) => detail.activeWork !== null).length;
  const staleOpenWorkCount = details.filter(
    (detail) => detail.activeWork !== null && detail.summary.status === "stale"
  ).length;
  const zeroEvidenceOpenWorkCount = details.filter(
    (detail) => detail.activeWork !== null && detail.activeWork.evidence.length === 0
  ).length;
  const weakScopeActorCount = details.filter((detail) => detail.weaknesses.length > 0).length;
  const routeableActiveCount = activeDetails.filter((detail) => detail.weaknesses.length === 0).length;
  const weakActiveCount = activeCount - routeableActiveCount;
  const doctorIssues = report.checks.filter((check) => check.level !== "ok");
  const activeActorLines = activeDetails.map(renderStatusActorLine);
  const openWorkLines = details.flatMap(renderStatusWorkLines);
  const pendingInboxLines = details.flatMap(renderStatusPendingInboxLines);
  const recommendationLines = statusRecommendations({
    pendingInboxCount,
    routeableActiveCount,
    weakActiveCount,
    recentMessageCount: recentMessages.length,
    staleOpenWorkCount,
    zeroEvidenceOpenWorkCount
  });

  const lines = [
    "AgentQ status",
    `Workspace: ${report.workspaceRoot}`,
    `Runtime store: ${report.storePath}`,
    `doctor: ${report.summary}`,
    `actors: ${details.length} (active ${activeCount}, stale ${staleCount}, staleAfter ${formatDuration(staleAfterMs)})`,
    `routeable active actors: ${routeableActiveCount}`,
    `broad/generic active actors: ${weakActiveCount}`,
    `pending inbox: ${pendingInboxCount}`,
    `open work: ${openWorkCount}`,
    `stale open work: ${staleOpenWorkCount}`,
    `zero-evidence open work: ${zeroEvidenceOpenWorkCount}`,
    `weak-scope actors: ${weakScopeActorCount}`,
    `recent messages 24h: ${recentMessages.length}${recentMessages[0] === undefined ? "" : ` (latest ${recentMessages[0].updatedAt})`}`
  ];

  if (doctorIssues.length > 0) {
    lines.push(
      "",
      "Doctor issues:",
      ...doctorIssues.map((check) => `  ${check.level} ${check.name}: ${check.detail}`)
    );
  }

  if (recommendationLines.length > 0) {
    lines.push(
      "",
      "Next:",
      `  ${statusNextAction({
        pendingInboxCount,
        weakActiveCount,
        zeroEvidenceOpenWorkCount,
        staleOpenWorkCount,
        routeableActiveCount,
        recentMessageCount: recentMessages.length
      })}`,
      "",
      "Recommendations:",
      ...recommendationLines.map((line) => `  ${line}`)
    );
  }

  lines.push(
    "",
    "Active actors:",
    ...(activeActorLines.length === 0 ? ["  none"] : activeActorLines),
    "",
    "Open work:",
    ...(openWorkLines.length === 0 ? ["  none"] : openWorkLines),
    "",
    "Pending inbox:",
    ...(pendingInboxLines.length === 0 ? ["  none"] : pendingInboxLines)
  );

  return `${lines.join("\n")}\n`;
}

async function listRecentMessageSummaries(
  store: Awaited<ReturnType<typeof openStore>>,
  nowMs: number,
  windowMs: number
): Promise<RecentMessageSummary[]> {
  const entries = await readdir(store.layout.messagesDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  });
  const summaries: RecentMessageSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const messagePath = store.layout.messagePath(entry.name);
    const fileStat = await stat(messagePath).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    });
    if (fileStat === null) {
      continue;
    }

    const updatedAtMs = fileStat.mtimeMs;
    if (Number.isFinite(nowMs) && nowMs - updatedAtMs > windowMs) {
      continue;
    }

    const state = await foldMessageState(store, entry.name);
    summaries.push({
      id: state.message.id,
      kind: state.message.kind,
      summary: state.message.summary,
      updatedAt: fileStat.mtime.toISOString(),
      updatedAtMs
    });
  }

  return summaries.sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id));
}

async function buildDiagnosticActivityRows(
  store: Awaited<ReturnType<typeof openStore>>,
  actors: readonly Presence[],
  events: readonly DiagnosticEvent[],
  nowMs: number,
  windowMs: number
): Promise<DiagnosticActivityRow[]> {
  const presenceByActor = new Map(actors.map((actor) => [actor.actorId, actor]));
  const eventsByActor = new Map<string, DiagnosticEvent[]>();
  for (const event of events) {
    if (event.actorId === undefined) {
      continue;
    }

    const existing = eventsByActor.get(event.actorId) ?? [];
    eventsByActor.set(event.actorId, [...existing, event]);
  }

  const actorIds = new Set(eventsByActor.keys());
  for (const actor of actors) {
    const lastSeenMs = Date.parse(actor.lastSeen);
    if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs >= 0 && nowMs - lastSeenMs <= windowMs) {
      actorIds.add(actor.actorId);
    }
  }

  const rows = await Promise.all(
    [...actorIds].map(async (actorId): Promise<DiagnosticActivityRow> => {
      const actor = presenceByActor.get(actorId);
      const actorEvents = [...(eventsByActor.get(actorId) ?? [])].sort((left, right) =>
        left.at.localeCompare(right.at)
      );
      const eventTimes = actorEvents
        .map((event) => Date.parse(event.at))
        .filter((value) => Number.isFinite(value));
      const gaps = eventTimes.slice(1).map((time, index) => time - (eventTimes[index] ?? time));
      const [pendingInbox, activeWork] = actor === undefined
        ? [[], null] as const
        : await Promise.all([
          listPendingInboxItems(store, actor.actorId),
          readActiveWorkState(store, actor.actorId)
        ]);
      const lastEventMs = eventTimes[eventTimes.length - 1];
      const lastSeenMs = actor === undefined ? Number.NaN : Date.parse(actor.lastSeen);

      return {
        actorId,
        eventCount: actorEvents.length,
        firstEventAt: actorEvents[0]?.at ?? null,
        lastEventAt: actorEvents[actorEvents.length - 1]?.at ?? null,
        lastEventAgeMs: lastEventMs === undefined ? null : Math.max(0, nowMs - lastEventMs),
        maxGapMs: gaps.length === 0 ? null : Math.max(...gaps),
        p95GapMs: percentile(gaps, 0.95),
        avgGapMs: gaps.length === 0
          ? null
          : gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length,
        lastSeenAgeMs: actor === undefined || !Number.isFinite(lastSeenMs)
          ? null
          : Math.max(0, nowMs - lastSeenMs),
        pendingInboxCount: pendingInbox.length,
        hasOpenWork: activeWork !== null,
        openWorkEvidenceCount: activeWork?.evidence.length ?? null,
        openWorkTitle: activeWork?.title ?? null,
        paths: actor?.activePaths ?? [],
        observedPaths: actor?.observedPaths ?? [],
        resources: actor?.activeResources ?? [],
        summary: actor?.summary ?? null
      };
    })
  );

  return rows.sort((left, right) =>
    right.eventCount - left.eventCount ||
    nullableNumber(left.lastEventAgeMs) - nullableNumber(right.lastEventAgeMs) ||
    left.actorId.localeCompare(right.actorId)
  );
}

function statusRecommendations(input: {
  readonly pendingInboxCount: number;
  readonly routeableActiveCount: number;
  readonly weakActiveCount: number;
  readonly recentMessageCount: number;
  readonly staleOpenWorkCount: number;
  readonly zeroEvidenceOpenWorkCount: number;
}): string[] {
  const lines: string[] = [];

  if (input.pendingInboxCount > 0) {
    lines.push("Required inbox items are pending; run `agentq inbox --actor <id>` for the affected actor and answer with `agentq respond ... --evidence \"...\"`.");
  }

  if (input.weakActiveCount > 0) {
    lines.push("Refresh broad active actors with `agentq enter --actor <id> --paths <owned-path> --responsibility \"<owned contract>\"`.");
  }

  if (input.routeableActiveCount > 1 && input.recentMessageCount === 0) {
    lines.push("No recent inter-agent messages; run `agentq owners --path <path>` or `agentq owners --resource <resource>` before editing shared surfaces or using exclusive tools, then ask/block when another active owner overlaps.");
  }

  if (input.staleOpenWorkCount > 0) {
    lines.push("Stale open work remains; close it with `agentq work close --status abandoned|superseded --evidence \"...\"` only with evidence from the responsible actor or current owner.");
  }

  if (input.zeroEvidenceOpenWorkCount > 0) {
    lines.push("Open work without context evidence remains; record the current frame, observed basis, touched paths/resources, and next pass check before it reaches the stop gate.");
  }

  return lines;
}

function statusNextAction(input: {
  readonly pendingInboxCount: number;
  readonly weakActiveCount: number;
  readonly zeroEvidenceOpenWorkCount: number;
  readonly staleOpenWorkCount: number;
  readonly routeableActiveCount: number;
  readonly recentMessageCount: number;
}): string {
  if (input.pendingInboxCount > 0) {
    return "Resolve pending inbox first: `agentq inbox --actor <id>` then `agentq respond ... --evidence \"...\"`.";
  }

  if (input.weakActiveCount > 0) {
    return "Refresh broad active scopes with `agentq enter --actor <id> --paths <owned-path> --responsibility \"<owned contract>\"`.";
  }

  if (input.zeroEvidenceOpenWorkCount > 0) {
    return "Record collaboration context on open work before any final answer: `agentq work evidence --actor <id> --evidence \"Context: current frame; observed basis; touched paths/resources; next pass check\"`.";
  }

  if (input.staleOpenWorkCount > 0) {
    return "Review stale open work and close only with ownership evidence: `agentq work close --status abandoned|superseded ...`.";
  }

  if (input.routeableActiveCount > 1 && input.recentMessageCount === 0) {
    return "Before shared edits, run `agentq owners --path <path>` or `--resource <resource>` and route a question/block on overlap.";
  }

  return "No urgent AgentQ action; keep using explicit `--actor`, `owners`, `work evidence`, and `done-check`.";
}

function renderOwners(
  paths: readonly string[],
  resources: readonly string[],
  pathMatches: readonly ActivePathOwnerMatch[],
  resourceMatches: readonly ActiveResourceOwnerMatch[]
): string {
  const lines = [
    `owners for ${[...paths, ...resources.map((resource) => `resource:${resource}`)].join(", ")}:`
  ];

  if (pathMatches.length === 0 && resourceMatches.length === 0) {
    lines.push(
      "  none",
      "",
      "Next:",
      "  No active owner matched. Do not route to broad actors or infer ownership from file mtimes.",
      "  If you know the exact actor, send `agentq question --to <actor-id>` for required decisions or `agentq note --to <actor-id>` for non-blocking context.",
      "  If no actor is knowable, record the evidence in the project handoff surface such as the relevant work queue or problem stack."
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(...pathMatches.map(renderOwnerMatch));
  lines.push(...resourceMatches.map(renderResourceOwnerMatch));
  const firstPath = pathMatches[0]?.queriedPath;
  const firstResource = resourceMatches[0]?.queriedResource;
  const targetActorId = pathMatches[0]?.actor.actorId ?? resourceMatches[0]?.actor.actorId ?? "<target-actor-id>";
  const routeArg = firstPath !== undefined
    ? `--path ${firstPath}`
    : `--resource ${firstResource ?? resources[0] ?? "<resource>"}`;
  lines.push(
    "",
    "Use a required question when this may affect the owner:",
    "  Ownership is a routing signal, not a lock. Ask the owner to classify overlap; do not wait silently from presence alone.",
    `  agentq question --actor <your-actor-id> --to ${targetActorId} ${routeArg} --question "<decision needed>" --expect "<answer with evidence>"`,
    "  Use `agentq note ...` instead when this is review/context and your completion should not wait for a reply."
  );
  return `${lines.join("\n")}\n`;
}

function renderOwnerMatch(match: ActivePathOwnerMatch): string {
  return [
    `  ${match.actor.actorId}`,
    `owns: ${match.activePath}`,
    `matched: ${match.queriedPath}`,
    `responsibilities: ${formatList(match.actor.responsibilities)}`
  ].join(" | ");
}

function renderResourceOwnerMatch(match: ActiveResourceOwnerMatch): string {
  return [
    `  ${match.actor.actorId}`,
    `owns-resource: ${match.activeResource}`,
    `matched: ${match.queriedResource}`,
    `responsibilities: ${formatList(match.actor.responsibilities)}`
  ].join(" | ");
}

function renderDiagnosticEvents(events: readonly DiagnosticEvent[]): string {
  const lines = ["AgentQ diagnostics"];
  if (events.length === 0) {
    lines.push("  empty");
    return `${lines.join("\n")}\n`;
  }

  for (const event of events) {
    lines.push(
      [
        `  ${event.at}`,
        event.actorId ?? "(no actor)",
        event.event ?? event.kind,
        event.toolName === undefined ? undefined : `tool:${event.toolName}`,
        event.paths === undefined ? undefined : `paths:${formatList(event.paths)}`,
        event.resources === undefined ? undefined : `resources:${formatList(event.resources)}`,
        event.ignoredCommands === undefined || event.ignoredCommands.length === 0
          ? undefined
          : `ignored:${event.ignoredCommands.length}`,
        event.nudge === undefined ? undefined : `nudge:${event.nudge ? "yes" : "no"}`
      ].filter((part): part is string => part !== undefined).join(" | ")
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderDiagnosticActivity(
  rows: readonly DiagnosticActivityRow[],
  input: DiagnosticActivityRenderInput
): string {
  const lines = [
    "AgentQ diagnostic activity",
    `Window: ${formatDuration(input.windowMs)}`,
    `Hook events in window: ${input.eventCount}`,
    `Actors shown: ${rows.length}/${input.rowCount}${input.rowCount > input.limit ? ` (limit ${input.limit})` : ""}`,
    "",
    "Actors:"
  ];
  if (rows.length === 0) {
    lines.push("  none");
    return `${lines.join("\n")}\n`;
  }

  for (const row of rows) {
    lines.push(
      [
        `  ${row.actorId}`,
        `events:${row.eventCount}`,
        `lastEvent:${formatNullableDuration(row.lastEventAgeMs)}`,
        `maxGap:${formatNullableDuration(row.maxGapMs)}`,
        `p95Gap:${formatNullableDuration(row.p95GapMs)}`,
        `avgGap:${formatNullableDuration(row.avgGapMs)}`,
        `lastSeen:${formatNullableDuration(row.lastSeenAgeMs)}`,
        `inbox:${row.pendingInboxCount}`,
        `work:${row.hasOpenWork ? "open" : "none"}`,
        row.openWorkEvidenceCount === null ? undefined : `evidence:${row.openWorkEvidenceCount}`,
        row.openWorkTitle === null ? undefined : `workTitle:${row.openWorkTitle}`,
        `paths:${formatList(row.paths)}`,
        row.observedPaths.length === 0 ? undefined : `observing:${formatList(row.observedPaths)}`,
        `resources:${formatList(row.resources)}`,
        row.summary === null ? undefined : `summary:${row.summary}`
      ].filter((part): part is string => part !== undefined).join(" | ")
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderStatusActorLine(detail: WorkspaceStatusActor): string {
  const actor = detail.summary.actor;
  return [
    `  ${actor.actorId}`,
    `age ${detail.summary.ageMs === null ? "unknown" : formatDuration(detail.summary.ageMs)}`,
    `paths: ${formatList(actor.activePaths)}`,
    ...(actor.observedPaths === undefined ? [] : [`observing: ${formatList(actor.observedPaths)}`]),
    ...(actor.activeResources === undefined ? [] : [`resources: ${formatList(actor.activeResources)}`]),
    `responsibilities: ${formatList(actor.responsibilities)}`
  ].join(" | ");
}

function renderStatusWorkLines(detail: WorkspaceStatusActor): string[] {
  if (detail.activeWork === null) {
    return [];
  }

  return [
    [
      `  ${detail.activeWork.workId}`,
      `actor: ${detail.summary.actor.actorId}`,
      `actorStatus: ${detail.summary.status}`,
      `status: ${detail.activeWork.status}`,
      `title: ${detail.activeWork.title}`,
      `evidence: ${detail.activeWork.evidence.length}`
    ].join(" | ")
  ];
}

function renderStatusPendingInboxLines(detail: WorkspaceStatusActor): string[] {
  return detail.pendingInbox.map((item) => [
    `  ${item.state.message.id}`,
    `to: ${detail.summary.actor.actorId}`,
    `from: ${item.state.message.createdBy}`,
    `summary: ${item.state.message.summary}`
  ].join(" | "));
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
    ...(actor.observedPaths === undefined ? [] : [`  observing: ${actor.observedPaths.join(", ")}`]),
    ...(actor.activeResources === undefined ? [] : [`  resources: ${actor.activeResources.join(", ")}`]),
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

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function parseDurationOption(value: string, label: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(value.trim());
  if (match === null) {
    throw new Error(`${label} must be a duration such as 30m, 1h, or 24h.`);
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "ms" ? 1 :
    unit === "s" ? 1_000 :
    unit === "m" ? 60_000 :
    unit === "h" ? 3_600_000 :
    unit === "d" ? 86_400_000 :
    Number.NaN;
  const ms = amount * multiplier;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`${label} must be a positive duration.`);
  }

  return ms;
}

function parseWorkTerminalStatus(value: string | undefined): WorkTerminalStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "closed" || value === "abandoned" || value === "superseded") {
    return value;
  }

  throw new Error("work close --status must be one of closed, abandoned, or superseded.");
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function nullableNumber(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function formatNullableDuration(ms: number | null): string {
  return ms === null ? "n/a" : formatDuration(ms);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
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
  if (work.status === "open" && work.evidence.length === 0) {
    lines.push(`  next: record collaboration context now: agentq work evidence --actor ${work.actorId} --evidence "Context: current frame; observed basis; touched paths/resources; next pass check"`);
  } else if (work.status === "open") {
    lines.push("  next: add missing final evidence or close with summary when the frame is actually done");
  }
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
