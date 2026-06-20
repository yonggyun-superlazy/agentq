#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTQ_POSITIONING,
  AGENTQ_TAGLINE,
  applyHookConfigInstall,
  applyHookConfigUninstall,
  appendActiveWorkTouch,
  appendWorkEvidence,
  clearTerminalActiveWorkPointer,
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
  listActiveWorkInventory,
  readDiagnosticEvents,
  planHookConfigInstall,
  planHookConfigUninstall,
  planMarkerInstall,
  planMarkerUninstall,
  planStopContinuation,
  planWorkStopContinuation,
  planScopeContinuation,
  refreshActorPresence,
  readActiveWorkStack,
  readActiveWorkState,
  resolveWorkspaceStore,
  runHookHandler,
  runScopeCheck,
  runDoctor,
  runWorkDoneCheck,
  startWork,
  actorScopeWeaknesses,
  isBookkeepingPresence,
  isNoisyPresencePath,
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
  type StartWorkFrameSpecInput,
  type ActiveWorkInventoryItem,
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
  readonly readStdin?: () => Promise<string>;
}

const DEFAULT_ACTOR_STALE_AFTER_MS = 3_600_000;
const RECENT_WORK_NUDGE_WINDOW_MS = 1_800_000;

export const COMMANDS: readonly CommandSpec[] = [
  { name: "install", summary: "Install agent instructions and hook gates" },
  { name: "doctor", summary: "Explain AgentQ workspace and hook state" },
  { name: "status", summary: "Summarize workspace AgentQ health" },
  { name: "next", summary: "Show the one AgentQ action this actor should take now" },
  { name: "uninstall", summary: "Remove AgentQ-owned integration markers and hook gates" },
  { name: "actors", summary: "List workspace actors by recent presence" },
  { name: "owners", summary: "Find active actors responsible for paths or resources" },
  { name: "enter", summary: "Register actor presence and responsibilities" },
  { name: "work", summary: "Manage actor work stacks and stale residue" },
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
      "  agentq work start --actor <id> --title <title> --path <path>... [--objective \"...\"] [--slice \"...\"] [--denominator \"...\"] [--pass \"...\"] [--next \"...\"]",
      "  agentq work status --actor <id>",
      "  agentq work touch --actor <id> --path <path>...",
      "  agentq work evidence --actor <id> --evidence \"...\"",
      "  agentq work evidence --actor <id> --evidence-file <path>",
      "  agentq work close --actor <id> --summary \"...\" [--evidence \"...\"] [--status closed|abandoned|superseded]",
      "  agentq work close --actor <id> --summary-file <path> [--evidence-file <path>] [--status closed|abandoned|superseded]",
      "  agentq work cleanup-stale [--stale-ms <ms>] [--dry-run]",
      "  agentq work cleanup-stale --yes [--stale-ms <ms>]",
      "",
      "cleanup-stale previews by default and only abandons started-only stale work with zero evidence."
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
      "  agentq block --actor <id> --summary-file <path> [--to <id>...] [--path <path>...]",
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
      "  agentq question --actor <id> --question-file <path> [--to <id>...] --path <path>...",
      "  agentq question --actor <id> --question-stdin [--to <id>...] --path <path>...",
      "",
      "Questions are required requests. The sender remains blocked until routed actors answer.",
      "Ask one required decision only. Put audits, history, options, and long reports in agentq note or project evidence before asking the smallest blocking question.",
      "Use --expect to name the exact answer shape, such as exact files active or no active overlap.",
      "Text options accept normal shell-split words until the next --option; use file/stdin only for exact multi-line text.",
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
      "  agentq note --actor <id> --note-file <path> [--to <id>...] --path <path>...",
      "  agentq note --actor <id> --note-stdin [--to <id>...] --path <path>...",
      "",
      "Notes are non-blocking inbox items. Use question or block when the sender must wait for a reply.",
      "Text options accept normal shell-split words until the next --option; use file/stdin only for exact multi-line text."
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
      "  agentq respond <message-id> --actor <id> --status <resolved|answered|not_mine|invalid|blocked> --evidence \"...\"",
      "  agentq respond <message-id> --actor <id> --status <resolved|answered|not_mine|invalid|blocked> --evidence-file <path>",
      "  agentq respond <message-id> --actor <id> --status <resolved|answered|not_mine|invalid|blocked> --evidence-stdin",
      "",
      "Text options accept normal shell-split words until the next --option; use file/stdin only for exact multi-line text."
    ].join("\n");
  }

  if (command.name === "supersede") {
    return [
      "agentq supersede",
      command.summary,
      "",
      "Usage:",
      "  agentq supersede <message-id> --actor <sender-id> --to <recipient-id> --evidence \"...\"",
      "  agentq supersede <message-id> --actor <sender-id> --to <recipient-id> --evidence-file <path>"
    ].join("\n");
  }

  if (command.name === "follow-up") {
    return [
      "agentq follow-up",
      command.summary,
      "",
      "Usage:",
      "  agentq follow-up <message-id> --actor <sender-id> --to <blocked-recipient-id> --evidence \"...\"",
      "  agentq follow-up <message-id> --actor <sender-id> --to <blocked-recipient-id> --evidence-file <path>"
    ].join("\n");
  }

  if (command.name === "accept-blocked") {
    return [
      "agentq accept-blocked",
      command.summary,
      "",
      "Usage:",
      "  agentq accept-blocked <message-id> --actor <sender-id> --to <blocked-recipient-id> --evidence \"...\"",
      "  agentq accept-blocked <message-id> --actor <sender-id> --to <blocked-recipient-id> --evidence-file <path>"
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

  if (command.name === "next") {
    return [
      "agentq next",
      command.summary,
      "",
      "Usage:",
      "  agentq next --actor <id>",
      "",
      "Use this as the agent-facing entrypoint before finishing or when AgentQ feels ambiguous.",
      "It renders one next action and the exact lower-level command only when needed."
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

function renderUnknownCommandError(command: string, argv: readonly string[]): string {
  const args = parseArgs(argv);
  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  const actorId = optionValue(args, "actor");
  const staleMs = optionValue(args, "stale-ms");
  const hasOwnerQuery = paths.length > 0 || resources.length > 0;

  if (command === "state") {
    const lines = [
      "agentq: unknown command: state",
      "",
      "State is not an AgentQ command. Use the command that matches the question:"
    ];

    if (hasOwnerQuery) {
      lines.push(`  ${formatSuggestedCommand([
        "agentq",
        "owners",
        ...paths.flatMap((value) => ["--path", value]),
        ...resources.flatMap((value) => ["--resource", value]),
        ...(actorId === undefined ? [] : ["--actor", actorId]),
        ...(staleMs === undefined ? [] : ["--stale-ms", staleMs])
      ])}`);
      lines.push("", "Path/resource queries are owner routing, not workspace state.");
      return `${lines.join("\n")}\n`;
    }

    if (actorId !== undefined) {
      lines.push(`  ${formatSuggestedCommand(["agentq", "next", "--actor", actorId])}`);
      lines.push("", "Actor-specific recovery should start from the single next action.");
      return `${lines.join("\n")}\n`;
    }

    lines.push(`  ${formatSuggestedCommand([
      "agentq",
      "status",
      ...(staleMs === undefined ? [] : ["--stale-ms", staleMs])
    ])}`);
    lines.push("", "Workspace health summaries use status.");
    return `${lines.join("\n")}\n`;
  }

  if (command === "owner" || command === "who" || command === "route") {
    const lines = [
      `agentq: unknown command: ${command}`,
      "",
      "Owner and route lookups use the owners command:"
    ];
    lines.push(`  ${formatSuggestedCommand([
      "agentq",
      "owners",
      ...(paths.length === 0 && resources.length === 0 ? ["--path", "<path>"] : []),
      ...paths.flatMap((value) => ["--path", value]),
      ...resources.flatMap((value) => ["--resource", value]),
      ...(actorId === undefined ? [] : ["--actor", actorId])
    ])}`);
    return `${lines.join("\n")}\n`;
  }

  if (command === "ask") {
    return [
      "agentq: unknown command: ask",
      "",
      "Required questions use:",
      "  agentq question --help"
    ].join("\n") + "\n";
  }

  if (command === "answer" || command === "reply") {
    return [
      `agentq: unknown command: ${command}`,
      "",
      "Answers to required requests use:",
      "  agentq respond --help"
    ].join("\n") + "\n";
  }

  if (command === "queue" || command === "messages") {
    return [
      `agentq: unknown command: ${command}`,
      "",
      "Inbox and queue inspection use:",
      "  agentq inbox --actor <id>",
      "  agentq status"
    ].join("\n") + "\n";
  }

  if (command === "list") {
    return [
      "agentq: unknown command: list",
      "",
      "Choose the list you need:",
      "  agentq actors",
      "  agentq status",
      "  agentq inbox --actor <id>"
    ].join("\n") + "\n";
  }

  return `agentq: unknown command: ${command}\n`;
}

function formatSuggestedCommand(parts: readonly string[]): string {
  return parts.map(formatCliToken).join(" ");
}

function formatCliToken(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value)
    ? value
    : JSON.stringify(value);
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

  if (command === "state") {
    const compatibilityResult = await stateCompatibilityCommand(argv.slice(1), runtime);
    if (compatibilityResult !== null) {
      return compatibilityResult;
    }
  }

  const commandSpec = COMMANDS.find((candidate) => candidate.name === command);
  if (commandSpec === undefined) {
    return { code: 2, stdout: "", stderr: renderUnknownCommandError(command, argv.slice(1)) };
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

  if (command === "next") {
    return await nextCommand(argv.slice(1), runtime);
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

async function stateCompatibilityCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult | null> {
  const args = parseArgs(argv);
  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  if (paths.length === 0 && resources.length === 0) {
    return null;
  }

  const actorId = optionValue(args, "actor");
  const staleMs = optionValue(args, "stale-ms");
  const ownerArgs = [
    ...paths.flatMap((value) => ["--path", value]),
    ...resources.flatMap((value) => ["--resource", value]),
    ...(actorId === undefined ? [] : ["--actor", actorId]),
    ...(staleMs === undefined ? [] : ["--stale-ms", staleMs])
  ];
  const result = await ownersCommand(ownerArgs, runtime);
  return {
    code: result.code,
    stdout: [
      "compatibility: agentq state path/resource queries are routed to agentq owners.",
      "",
      result.stdout.trimEnd()
    ].join("\n") + "\n",
    stderr: result.stderr
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
        "Manage actor work stacks and stale residue",
        "",
        "Usage:",
        "  agentq work start --actor <id> --title <title> --path <path>... [--objective \"...\"] [--slice \"...\"] [--denominator \"...\"] [--pass \"...\"] [--next \"...\"]",
        "  agentq work status --actor <id>",
        "  agentq work touch --actor <id> --path <path>...",
        "  agentq work evidence --actor <id> --evidence \"...\"",
        "  agentq work evidence --actor <id> --evidence-file <path>",
        "  agentq work close --actor <id> --summary \"...\" [--evidence \"...\"] [--status closed|abandoned|superseded]",
        "  agentq work close --actor <id> --summary-file <path> [--evidence-file <path>] [--status closed|abandoned|superseded]",
        "  agentq work cleanup-stale [--stale-ms <ms>] [--dry-run]",
        "  agentq work cleanup-stale --yes [--stale-ms <ms>]",
        "",
        "cleanup-stale previews by default and only abandons started-only stale work with zero evidence."
      ].join("\n") + "\n",
      stderr: ""
    };
  }

  const args = parseArgs(argv.slice(1));

  if (subcommand === "cleanup-stale") {
    return await workCleanupStaleCommand(args, runtime);
  }

  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);

  if (subcommand === "start") {
    assertNoUnexpectedPositionals(args, "work start", 0);
    const workId = optionValue(args, "id");
    const goal = await textOption(args, "goal", runtime, "work start");
    const objective = await textOption(args, "objective", runtime, "work start");
    const slice = await textOption(args, "slice", runtime, "work start");
    const denominator = await textOptionValues(args, "denominator", runtime, "work start");
    const passCriteria = await textOptionValues(args, "pass", runtime, "work start");
    const nextOperation = await textOption(args, "next", runtime, "work start");
    const stopCondition = await textOption(args, "stop-condition", runtime, "work start");
    const specObjective = objective ?? goal;
    const activeResources = optionValues(args, "resource");
    const paths = requiredSpecificPathOptions(args, "path", "work start");
    const title = await requiredTextOption(args, "title", runtime, "work start");
    const state = await startWork(store, {
      actorId,
      title,
      paths,
      now: runtime.now(),
      ...(workId === undefined ? {} : { workId }),
      ...(goal === undefined ? {} : { goal }),
      spec: workStartSpec({
        ...(specObjective === undefined ? {} : { objective: specObjective }),
        ...(slice === undefined ? {} : { slice }),
        denominator,
        passCriteria,
        ...(nextOperation === undefined ? {} : { nextOperation }),
        ...(stopCondition === undefined ? {} : { stopCondition })
      }),
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
    const stack = await readActiveWorkStack(store, actorId);
    return {
      code: 0,
      stdout: stack.length === 0 ? `no active work for ${actorId}\n` : renderWorkStackStatus(actorId, stack),
      stderr: ""
    };
  }

  if (subcommand === "touch") {
    assertNoUnexpectedPositionals(args, "work touch", 0);
    const paths = pathOptionValues(args, "path");
    for (const pathValue of paths) {
      assertCliWorkPathQuality(pathValue);
    }
    const activeBeforeTouch = await readActiveWorkState(store, actorId);
    if (activeBeforeTouch !== null && activeBeforeTouch.evidence.length === 0) {
      throw new Error("AgentQ work touch requires qualitative context evidence before recording touched paths.");
    }
    const state = await appendActiveWorkTouch(store, {
      actorId,
      paths,
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
    assertNoUnexpectedPositionals(args, "work evidence", 0);
    const state = await appendWorkEvidence(store, {
      actorId,
      evidence: await textOptionValues(args, "evidence", runtime, "work evidence"),
      now: runtime.now()
    });
    return {
      code: 0,
      stdout: renderWorkState("evidence", state),
      stderr: ""
    };
  }

  if (subcommand === "close") {
    assertNoUnexpectedPositionals(args, "work close", 0);
    const status = parseWorkTerminalStatus(optionValue(args, "status"));
    const summary = await requiredTextOption(args, "summary", runtime, "work close");
    const evidence = await textOptionValues(args, "evidence", runtime, "work close");
    const beforeClose = await readActiveWorkState(store, actorId);
    assertCliQualitativeClosureEvidence([
      ...(beforeClose?.evidence ?? []),
      ...evidence,
      summary
    ].join(" "));
    const state = await closeWork(store, {
      actorId,
      summary,
      evidence,
      ...(status === undefined ? {} : { status }),
      now: runtime.now()
    });
    const returnStack = await readActiveWorkStack(store, actorId);
    return {
      code: 0,
      stdout: renderWorkState("closed", state, { returnStack }),
      stderr: ""
    };
  }

  return {
    code: 2,
    stdout: "",
    stderr: `agentq: unknown work command: ${subcommand}\n`
  };
}

async function workCleanupStaleCommand(args: ParsedArgs, runtime: CommandRuntime): Promise<CommandResult> {
  assertNoUnexpectedPositionals(args, "work cleanup-stale", 0);
  if (args.flags.has("dry-run") && args.flags.has("yes")) {
    throw new Error("work cleanup-stale accepts either --dry-run or --yes, not both.");
  }

  const staleAfterMs = parseNonNegativeMsOption(
    args,
    "stale-ms",
    DEFAULT_ACTOR_STALE_AFTER_MS,
    "work cleanup-stale"
  );
  const mutate = args.flags.has("yes");
  const store = await openStore(runtime);
  const now = runtime.now();
  const nowMs = Date.parse(now);
  const diagnosticEvents = await readDiagnosticEvents(store, 10_000);
  const details = await readWorkspaceStatusDetails(store, nowMs, staleAfterMs, diagnosticEvents);
  const workInventory = await readWorkspaceStatusWorkInventory(store, details);
  const candidates = collectStartedOnlyStaleWorkCleanupCandidates(workInventory, nowMs, staleAfterMs);
  const terminalPointers = workInventory.filter(isTerminalActiveWorkPointerItem);

  const abandoned: WorkState[] = [];
  const terminalCleared: WorkState[] = [];
  if (mutate) {
    for (const candidate of candidates) {
      const work = candidate.item.activeWork;
      if (work === null) {
        continue;
      }
      abandoned.push(await closeWork(store, {
        actorId: candidate.item.pointer.actorId,
        workId: work.workId,
        status: "abandoned",
        summary: "Abandoned stale started-only work residue after workspace cleanup review.",
        evidence: [renderStaleWorkCleanupEvidence(candidate, now)],
        now
      }));
    }
    for (const item of terminalPointers) {
      const cleared = await clearTerminalActiveWorkPointer(store, item.pointer.actorId, now);
      if (cleared !== null) {
        terminalCleared.push(cleared);
      }
    }
  }

  return {
    code: 0,
    stdout: renderStaleWorkCleanupResult({
      mutate,
      staleAfterMs,
      candidates,
      terminalPointerCount: terminalPointers.length,
      abandonedCount: abandoned.length,
      terminalClearedCount: terminalCleared.length
    }),
    stderr: ""
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
  const staleAfterMs = parseNonNegativeMsOption(args, "stale-ms", DEFAULT_ACTOR_STALE_AFTER_MS, "status");

  const store = await openStore(runtime);
  const report = await runDoctor(runtime.cwd, { env: runtime.env });
  const now = runtime.now();
  const nowMs = Date.parse(now);
  const diagnosticEvents = await readDiagnosticEvents(store, 10_000);
  const details = await readWorkspaceStatusDetails(store, nowMs, staleAfterMs, diagnosticEvents);
  const workInventory = await readWorkspaceStatusWorkInventory(store, details);
  const recentMessages = await listRecentMessageSummaries(store, nowMs, 86_400_000);
  const recentOwnerOverlapNudgeCount = countRecentOwnerOverlapNudges(diagnosticEvents, nowMs, 86_400_000);

  return {
    code: report.summary === "fail" ? 2 : 0,
    stdout: renderWorkspaceStatus(
      report,
      details,
      workInventory,
      nowMs,
      staleAfterMs,
      recentMessages,
      recentOwnerOverlapNudgeCount
    ),
    stderr: ""
  };
}

async function readWorkspaceStatusDetails(
  store: Awaited<ReturnType<typeof openStore>>,
  nowMs: number,
  staleAfterMs: number,
  diagnosticEvents: readonly DiagnosticEvent[]
): Promise<readonly WorkspaceStatusActor[]> {
  const actors = await listActorPresences(store);

  return await Promise.all(
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
        weaknesses: actorScopeWeaknesses(actor),
        recentWorkAdoptionNudge: findRecentWorkAdoptionNudge(
          diagnosticEvents,
          actor.actorId,
          nowMs,
          RECENT_WORK_NUDGE_WINDOW_MS
        )
      };
    })
  );
}

async function readWorkspaceStatusWorkInventory(
  store: Awaited<ReturnType<typeof openStore>>,
  details: readonly WorkspaceStatusActor[]
): Promise<readonly WorkspaceStatusWorkItem[]> {
  const detailsByActor = new Map(details.map((detail) => [detail.summary.actor.actorId, detail]));
  return (await listActiveWorkInventory(store)).map((item): WorkspaceStatusWorkItem => ({
    pointer: item.pointer,
    activeWork: item.activeWork,
    actor: detailsByActor.get(item.pointer.actorId) ?? null
  }));
}

async function nextCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);
  const nowMs = Date.parse(runtime.now());
  const [inboxItems, doneResult, workResult, scopeResult, resolvedOutbound, diagnosticEvents] = await Promise.all([
    listInboxItems(store, actorId),
    runDoneCheck(store, actorId),
    runWorkDoneCheck(store, actorId),
    runScopeCheck(store, actorId),
    resolvedOutboundItems(store, actorId),
    readDiagnosticEvents(store, 10_000)
  ]);

  return {
    code: 0,
    stdout: renderNextAction({
      actorId,
      inboxItems,
      doneResult,
      workResult,
      scopeResult,
      resolvedOutbound,
      recentWorkAdoptionNudge: findRecentWorkAdoptionNudge(
        diagnosticEvents,
        actorId,
        nowMs,
        RECENT_WORK_NUDGE_WINDOW_MS
      ),
      queueStackUx: queueStackUxEnabled(runtime.env)
    }),
    stderr: ""
  };
}

interface NextActionInput {
  readonly actorId: string;
  readonly inboxItems: Awaited<ReturnType<typeof listInboxItems>>;
  readonly doneResult: Awaited<ReturnType<typeof runDoneCheck>>;
  readonly workResult: Awaited<ReturnType<typeof runWorkDoneCheck>>;
  readonly scopeResult: Awaited<ReturnType<typeof runScopeCheck>>;
  readonly resolvedOutbound: readonly ResolvedOutboundItem[];
  readonly recentWorkAdoptionNudge: RecentWorkAdoptionNudge | null;
  readonly queueStackUx: boolean;
}

function renderNextAction(input: NextActionInput): string {
  const requiredInbox = input.inboxItems.filter((item) => item.request.blocksReceiverDone);
  const notes = input.inboxItems.filter((item) => !item.request.blocksReceiverDone);
  const lines = [`AgentQ next for ${input.actorId}`];

  if (requiredInbox.length > 0) {
    const item = requiredInbox[0];
    if (item !== undefined) {
      return renderNextRequiredInbox(
        input.actorId,
        item,
        requiredInbox.length,
        input.queueStackUx ? input.workResult.activeStack ?? [] : []
      );
    }
  }

  const blocking = input.doneResult.blocking[0];
  if (blocking !== undefined) {
    return renderNextDoneBlocker(input.actorId, blocking);
  }

  if (!input.scopeResult.ok) {
    lines.push(
      "Action: refresh your actor scope.",
      ...input.scopeResult.weaknesses.map((weakness) => `- ${weakness.kind}: ${weakness.detail}`),
      "Run for file/code tasks:",
      `  agentq enter --actor ${input.actorId} --paths <owned-path> [--resource <resource>] --responsibility "<owned contract>"`,
      "Run for file-less judgment or conversation-only tasks:",
      `  agentq enter --actor ${input.actorId} --resource conversation:current-request --responsibility "<concrete user task>"`,
      "Then:",
      `  agentq next --actor ${input.actorId}`
    );
    return `${lines.join("\n")}\n`;
  }

  if (!input.workResult.ok && input.workResult.activeWork !== undefined) {
    const work = input.workResult.activeWork;
    const stack = input.workResult.activeStack ?? [work];
    const parentReturn = input.workResult.parentReturnEvidenceRequired;
    lines.push(
      parentReturn !== undefined
        ? "Action: record parent-return evidence that rechecks the restored parent work before closing it."
        : work.evidence.length === 0
        ? "Action: record context evidence for your active work."
        : "Action: close or update your active work before claiming done.",
      `Work: ${work.workId} - ${work.spec.objective}`,
      ...renderCompactWorkContextLines(stack),
      ...renderWorkStackLines(stack, "Stack"),
      parentReturn !== undefined
        ? `Returned from child: ${parentReturn.fromWorkId} at ${parentReturn.since}`
        : "",
      parentReturn !== undefined
        ? `Run: agentq work evidence --actor ${input.actorId} --evidence "Parent return: rechecked parent denominator after child close; next pass check"`
        : work.evidence.length === 0
        ? `Run: agentq work evidence --actor ${input.actorId} --evidence "Context: current frame; observed basis; touched paths/resources; next pass check"`
        : `Run: agentq work close --actor ${input.actorId} --summary "<what changed and how it was verified>"`,
      "Then:",
      `  agentq next --actor ${input.actorId}`
    );
    return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
  }

  if (input.recentWorkAdoptionNudge !== null) {
    const nudge = input.recentWorkAdoptionNudge;
    const firstPath = nudge.latestPaths.find((value) => value !== ".");
    lines.push(
      "Action: start or confirm active work before continuing.",
      `Recent work-adoption nudge: ${nudge.count} in the last ${formatDuration(RECENT_WORK_NUDGE_WINDOW_MS)}; latest ${nudge.latestAt}`,
      `Paths: ${formatList(nudge.latestPaths)}`,
      nudge.latestResources.length === 0 ? "" : `Resources: ${formatList(nudge.latestResources)}`,
      "Run:",
      `  agentq work start --actor ${input.actorId} --title "<current slice>" --objective "<current objective>" --path ${firstPath ?? "<specific-path>"}`,
      "Then:",
      `  agentq next --actor ${input.actorId}`
    );
    return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
  }

  if (input.resolvedOutbound.length > 0) {
    const item = input.resolvedOutbound[0];
    if (item !== undefined) {
      lines.push(
        "Action: continue current task with the answered evidence below.",
        `Reply: ${item.messageId} ${item.status} by ${item.to}`,
        `Summary: ${item.summary}`,
        ...item.evidence.map((evidence) => `Evidence: ${evidence}`),
        "This is informational; it does not need to be cleared."
      );
      return `${lines.join("\n")}\n`;
    }
  }

  if (notes.length > 0) {
    const item = notes[0];
    if (item !== undefined) {
      const message = item.state.message;
      lines.push(
        "Action: continue current work; optional note is waiting.",
        `Note: ${message.id} from ${message.createdBy}`,
        `Summary: ${message.summary}`,
        message.kind === "note" ? `Body: ${message.body}` : "",
        "Optional ack:",
        `  agentq respond ${message.id} --actor ${input.actorId} --status resolved --evidence "<acknowledged if useful>"`
      );
      return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
    }
  }

  lines.push(
    "Action: continue current task.",
    "No required replies, active work, or scope blockers are open.",
    "Before final response:",
    "  Translate shared-work evidence into the user-visible result, request impact, verification, and remaining scope.",
    `  agentq done-check --actor ${input.actorId}`
  );
  return `${lines.join("\n")}\n`;
}

function renderNextRequiredInbox(
  actorId: string,
  item: Awaited<ReturnType<typeof listInboxItems>>[number],
  totalRequired: number,
  activeStack: readonly WorkState[]
): string {
  const message = item.state.message;
  const status = message.kind === "question" ? "answered" : "resolved";
  const lines = [
    `AgentQ next for ${actorId}`,
    "Action: answer the required inbox item.",
    `Item: ${message.id} (${message.summary})`,
    `From: ${message.createdBy}`,
    ...renderNextMessageBody(message),
    "Run:",
    `  agentq respond ${message.id} --actor ${actorId} --status ${status} --evidence "<answer with evidence>"`,
    ...renderReturnStackLines(activeStack),
    "Then:",
    `  agentq next --actor ${actorId}`
  ];
  if (totalRequired > 1) {
    lines.splice(4, 0, `More required items after this: ${totalRequired - 1}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderNextMessageBody(message: Message): string[] {
  if (message.kind === "question") {
    return [
      `Question: ${message.question}`,
      ...(message.expectedAnswer === undefined ? [] : [`Expected: ${message.expectedAnswer}`])
    ];
  }

  if (message.kind === "note") {
    return [`Note: ${message.body}`];
  }

  return [
    `Observed: ${message.observed}`,
    `Broken: ${message.brokenContract}`
  ];
}

function renderNextDoneBlocker(
  actorId: string,
  blocker: Awaited<ReturnType<typeof runDoneCheck>>["blocking"][number]
): string {
  const lines = [`AgentQ next for ${actorId}`];
  if (blocker.kind === "outbound_pending") {
    lines.push(
      "Action: wait for the required reply; do not poll AgentQ for the same pending item.",
      `Pending: ${blocker.messageId} for ${blocker.actorId}`,
      `Summary: ${blocker.summary}`,
      "Next local action: continue only work that cannot touch this reply path, or stop and wait for the receiver evidence.",
      "Do not supersede just to make done-check pass."
    );
    return `${lines.join("\n")}\n`;
  }

  if (blocker.kind === "outbound_blocked_requires_follow_up") {
    lines.push(
      "Action: follow up on the blocked reply or explicitly accept the blocked evidence.",
      `Blocked: ${blocker.messageId} by ${blocker.actorId}`,
      `Summary: ${blocker.summary}`,
      "Run one:",
      `  agentq follow-up ${blocker.messageId} --actor ${actorId} --to ${blocker.actorId} --evidence "<what is still needed>"`,
      `  agentq accept-blocked ${blocker.messageId} --actor ${actorId} --to ${blocker.actorId} --evidence "<why this is enough>"`
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "Action: inspect inbox.",
    `Run: agentq inbox --actor ${actorId}`
  );
  return `${lines.join("\n")}\n`;
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

  const stdin = await (runtime.readStdin ?? readStdin)();
  if (stdin.trim().length === 0) {
    const result = await runHookHandler({
      adapter,
      event,
      payload: fallbackHookPayload(adapter, event, runtime),
      defaultCwd: runtime.cwd,
      defaultSessionId: fallbackHookSessionId(adapter, runtime.env),
      env: runtime.env,
      now: runtime.now()
    });
    return {
      ...result,
      stderr: `agentq: hook received no JSON payload on stdin; using fallback cwd/session.\n${result.stderr}`
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    const result = await runHookHandler({
      adapter,
      event,
      payload: fallbackHookPayload(adapter, event, runtime),
      defaultCwd: runtime.cwd,
      defaultSessionId: fallbackHookSessionId(adapter, runtime.env),
      env: runtime.env,
      now: runtime.now()
    });
    return {
      ...result,
      stderr: `agentq: hook received invalid JSON payload on stdin; using fallback cwd/session.\n${result.stderr}`
    };
  }
  return await runHookHandler({
    adapter,
    event,
    payload,
    defaultCwd: runtime.cwd,
    defaultSessionId: fallbackHookSessionId(adapter, runtime.env),
    env: runtime.env,
    now: runtime.now()
  });
}

function fallbackHookPayload(adapter: HookAdapter, event: HookRuntimeEvent, runtime: CommandRuntime): object {
  return {
    cwd: runtime.cwd,
    session_id: fallbackHookSessionId(adapter, runtime.env),
    hook_event_name: event,
    agentq_payload_fallback: true
  };
}

function fallbackHookSessionId(adapter: HookAdapter, env: NodeJS.ProcessEnv): string {
  return env.AGENTQ_SESSION_ID ??
    env.CODEX_SESSION_ID ??
    env.CODEX_CONVERSATION_ID ??
    `${adapter}-hook-fallback`;
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
  const agentRows = buildDiagnosticAgentActivityRows(rows);

  return {
    code: 0,
    stdout: renderDiagnosticActivity(rows.slice(0, limit), {
      windowMs,
      eventCount: windowEvents.length,
      rowCount: rows.length,
      limit,
      agentRows
    }),
    stderr: ""
  };
}

async function enterCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const paths = pathOptionValues(args, "paths");
  const activeResources = optionValues(args, "resource");
  const responsibilities = cleanInlineTextValues(args, "responsibility", "enter");
  const store = await openStore(runtime);
  const actorId = optionValue(args, "actor");
  if (actorId !== undefined) {
    const summary = await textOption(args, "summary", runtime, "enter");
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
  const summary = await textOption(args, "summary", runtime, "enter") ?? responsibilities[0] ?? `${adapter} actor`;
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
  assertNoUnexpectedPositionals(args, "block", 0);
  const store = await openStore(runtime);
  const id = optionValue(args, "id") ?? `AQ-${Date.now()}`;
  const to = optionValues(args, "to");
  const summary = await requiredTextOption(args, "summary", runtime, "block");
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
    observed: await textOption(args, "observed", runtime, "block") ?? summary,
    brokenContract: await textOption(args, "contract-broken", runtime, "block") ?? "required handoff must be answered"
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
    stdout: renderRoutedDelivery(id, message.createdBy, plan.recipients.map((recipient) => recipient.actorId), delivery),
    stderr: ""
  };
}

async function questionCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  assertNoUnexpectedPositionals(args, "question", 0);
  const store = await openStore(runtime);
  const id = optionValue(args, "id") ?? `AQ-${Date.now()}`;
  const to = optionValues(args, "to");
  const question = await requiredTextOption(args, "question", runtime, "question");
  const paths = pathOptionValues(args, "path");
  const resources = optionValues(args, "resource");
  const contracts = optionValues(args, "contract");
  if (paths.length === 0 && resources.length === 0 && contracts.length === 0) {
    throw new Error("question requires --path, --resource, or --contract so recipients can judge relevance.");
  }
  const expectedAnswer = await textOption(args, "expect", runtime, "question");
  const passCriteria = optionValues(args, "pass");
  assertRequiredQuestionQuality(question);
  const message: Message = {
    id,
    kind: "question",
    createdBy: requiredOption(args, "actor"),
    summary: await textOption(args, "summary", runtime, "question") ?? question,
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
    stdout: renderRoutedDelivery(id, message.createdBy, plan.recipients.map((recipient) => recipient.actorId), delivery),
    stderr: ""
  };
}

async function noteCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  assertNoUnexpectedPositionals(args, "note", 0);
  const store = await openStore(runtime);
  const id = optionValue(args, "id") ?? `AQ-${Date.now()}`;
  const to = optionValues(args, "to");
  const note = await requiredTextOption(args, "note", runtime, "note");
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
    summary: await textOption(args, "summary", runtime, "note") ?? note,
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
    stdout: renderNonBlockingDelivery(id, message.createdBy, plan.recipients.map((recipient) => recipient.actorId)),
    stderr: ""
  };
}

function renderRoutedDelivery(
  messageId: string,
  senderActorId: string,
  recipientActorIds: readonly string[],
  delivery: DeliveryReport
): string {
  return [
    `${messageId} routed to ${recipientActorIds.join(", ")}`,
    renderDeliveryReport(delivery),
    `next: run \`agentq next --actor ${senderActorId}\` before finishing; answered evidence will be shown there once resolved.`
  ].join("\n") + "\n";
}

function renderNonBlockingDelivery(
  messageId: string,
  senderActorId: string,
  recipientActorIds: readonly string[]
): string {
  return [
    `${messageId} noted to ${recipientActorIds.join(", ")}`,
    "delivery:",
    ...recipientActorIds.map((actorId) => `  ${actorId}: inbox_note non_blocking`),
    `next: no reply is required; run \`agentq next --actor ${senderActorId}\` before finishing.`
  ].join("\n") + "\n";
}

async function inboxCommand(argv: readonly string[], runtime: CommandRuntime): Promise<CommandResult> {
  const args = parseArgs(argv);
  const actorId = requiredOption(args, "actor");
  const store = await openStore(runtime);
  const [openRequests, activeStack] = await Promise.all([
    listInboxItems(store, actorId),
    readActiveWorkStack(store, actorId)
  ]);
  const useQueueStackUx = queueStackUxEnabled(runtime.env);

  return {
    code: 0,
    stdout: openRequests.length === 0
      ? "inbox empty\n"
      : useQueueStackUx
        ? renderResolveQueueInbox(actorId, openRequests, activeStack)
        : `${openRequests.map((item) => renderInboxRequest(actorId, item.state, item.request)).join("\n\n")}\n`,
    stderr: ""
  };
}

function queueStackUxEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AGENTQ_QUEUE_STACK_UX;
  if (raw === undefined) {
    return true;
  }

  return !["0", "false", "off", "legacy"].includes(raw.trim().toLowerCase());
}

function workStartSpec(input: {
  readonly objective?: string;
  readonly slice?: string;
  readonly denominator: readonly string[];
  readonly passCriteria: readonly string[];
  readonly nextOperation?: string;
  readonly stopCondition?: string;
}): StartWorkFrameSpecInput {
  const spec: {
    objective?: string;
    slice?: string;
    denominator?: readonly string[];
    passCriteria?: readonly string[];
    nextOperation?: string;
    stopCondition?: string;
  } = {};
  if (input.objective !== undefined) {
    spec.objective = input.objective;
  }
  if (input.slice !== undefined) {
    spec.slice = input.slice;
  }
  if (input.denominator.length > 0) {
    spec.denominator = input.denominator;
  }
  if (input.passCriteria.length > 0) {
    spec.passCriteria = input.passCriteria;
  }
  if (input.nextOperation !== undefined) {
    spec.nextOperation = input.nextOperation;
  }
  if (input.stopCondition !== undefined) {
    spec.stopCondition = input.stopCondition;
  }
  return spec;
}

function renderResolveQueueInbox(
  actorId: string,
  openRequests: Awaited<ReturnType<typeof listInboxItems>>,
  activeStack: readonly WorkState[]
): string {
  const required = openRequests.filter((item) => item.request.blocksReceiverDone);
  const optional = openRequests.filter((item) => !item.request.blocksReceiverDone);
  const lines = [
    `Resolve queue for ${actorId}`,
    `Required: ${required.length}`,
    `Optional: ${optional.length}`,
    ...renderReturnStackLines(activeStack)
  ];

  if (required.length > 0) {
    lines.push("", "Required replies:");
    for (const item of required) {
      lines.push(...renderResolveQueueItem(actorId, item.state, item.request, activeStack));
    }
  }

  if (optional.length > 0) {
    lines.push("", "Optional notes:");
    for (const item of optional) {
      lines.push(...renderResolveQueueItem(actorId, item.state, item.request, activeStack));
    }
  }

  lines.push("", `After resolving useful items, run: agentq next --actor ${actorId}`);
  return `${lines.join("\n")}\n`;
}

function renderReturnStackLines(activeStack: readonly WorkState[]): string[] {
  const current = activeStack[activeStack.length - 1];
  if (current === undefined) {
    return ["Return stack: none"];
  }

  return [
    "Return stack:",
    `  current: ${current.workId} - ${current.spec.objective}`,
    ...(current.spec.nextOperation === undefined ? [] : [`  next: ${current.spec.nextOperation}`]),
    ...renderWorkStackLines(activeStack, "  lineage")
  ];
}

function renderResolveQueueItem(
  actorId: string,
  state: FoldedMessageState,
  request: FoldedRequest,
  activeStack: readonly WorkState[]
): string[] {
  const message = state.message;
  const required = request.request.required;
  const responseStatus = message.kind === "question" ? "answered" : "resolved";
  const action = required ? "respond" : "ack";
  const lines = [
    `- ${message.id} [${required ? "required" : "optional"}] ${message.summary}`,
    `  why: ${required ? "required reply blocks done-check" : "optional context; done-check can pass without this ack"}`,
    `  from: ${message.createdBy}`,
    `  related: ${describeInboxRelation(message, activeStack)}`,
    `  paths: ${joinList(message.paths)}`,
    `  resources: ${joinList(message.resources ?? [])}`,
    `  contracts: ${joinList(message.contracts)}`,
    ...renderResolveQueueMessageBody(message),
    required ? `  pass: ${joinList(message.passCriteria)}` : "",
    `  routing: ${request.request.routingEvidence.map((evidence) => `${evidence.kind}:${evidence.detail}`).join("; ")}`,
    `  ${action}: agentq respond ${message.id} --actor ${actorId} --status ${responseStatus} --evidence "..."`,
    `  next: ${inboxItemNext(message.kind, required)}`
  ];

  return lines.filter((line) => line.length > 0);
}

function renderResolveQueueMessageBody(message: Message): string[] {
  if (message.kind === "question") {
    return [
      `  question: ${message.question}`,
      ...(message.expectedAnswer === undefined ? [] : [`  expected: ${message.expectedAnswer}`])
    ];
  }

  if (message.kind === "note") {
    return [`  note: ${message.body}`];
  }

  return [
    `  observed: ${message.observed}`,
    `  broken: ${message.brokenContract}`
  ];
}

function describeInboxRelation(message: Message, activeStack: readonly WorkState[]): string {
  const current = activeStack[activeStack.length - 1];
  if (current === undefined) {
    return "no active work stack";
  }

  const activePaths = [...current.paths, ...current.touchedPaths];
  const overlap = message.paths.find((messagePath) => activePaths.some((activePath) => pathsOverlap(activePath, messagePath)));
  if (overlap !== undefined) {
    return `current stack path overlap: ${overlap}`;
  }

  return `current stack ${current.workId}; classify whether this changes your frame before editing`;
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function normalizeComparablePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
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
  assertNoUnexpectedPositionals(args, "respond", 1);
  const messageId = args.positionals[0];
  if (messageId === undefined) {
    throw new Error("respond requires a message id");
  }

  const store = await openStore(runtime);
  const actorId = requiredOption(args, "actor");
  const status = requiredOption(args, "status") as ResponseStatus;
  const evidence = await requiredTextOption(args, "evidence", runtime, "respond");
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
  assertNoUnexpectedPositionals(args, "supersede", 1);
  const messageId = args.positionals[0];
  if (messageId === undefined) {
    throw new Error("supersede requires a message id");
  }

  const store = await openStore(runtime);
  const actorId = requiredOption(args, "actor");
  const targetActorId = requiredOption(args, "to");
  const evidence = await requiredTextOption(args, "evidence", runtime, "supersede");
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
  assertNoUnexpectedPositionals(args, kind === "follow_up" ? "follow-up" : "accept-blocked", 1);
  const messageId = args.positionals[0];
  if (messageId === undefined) {
    throw new Error(`${kind === "follow_up" ? "follow-up" : "accept-blocked"} requires a message id`);
  }

  const store = await openStore(runtime);
  const actorId = requiredOption(args, "actor");
  const blockedActorId = requiredOption(args, "to");
  const evidence = await requiredTextOption(args, "evidence", runtime, kind === "follow_up" ? "follow-up" : "accept-blocked");
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

const GREEDY_TEXT_OPTIONS = new Set([
  "broken-contract",
  "contract-broken",
  "evidence",
  "evidence-file",
  "expect",
  "goal",
  "denominator",
  "note",
  "note-file",
  "next",
  "objective",
  "observed",
  "pass",
  "question",
  "question-file",
  "responsibility",
  "slice",
  "stop-condition",
  "summary",
  "summary-file",
  "title"
]);

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

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      const name = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      const existing = options.get(name) ?? [];
      options.set(name, [...existing, value]);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
      continue;
    }

    if (GREEDY_TEXT_OPTIONS.has(name)) {
      const values: string[] = [];
      let valueIndex = index + 1;
      while (valueIndex < argv.length) {
        const valueToken = argv[valueIndex];
        if (valueToken === undefined || valueToken.startsWith("--")) {
          break;
        }

        values.push(valueToken);
        valueIndex += 1;
      }

      const existing = options.get(name) ?? [];
      options.set(name, [...existing, values.join(" ")]);
      index = valueIndex - 1;
      continue;
    }

    const existing = options.get(name) ?? [];
    options.set(name, [...existing, next]);
    index += 1;
  }

  return { flags, options, positionals };
}

function assertNoUnexpectedPositionals(args: ParsedArgs, commandName: string, allowedCount: number): void {
  if (args.positionals.length <= allowedCount) {
    return;
  }

  const extra = args.positionals.slice(allowedCount).join(" ");
  throw new Error(
    `${commandName} received unexpected positional text: ${extra}. ` +
    "Put free text after a text option such as --question, --evidence, --summary, or --pass."
  );
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = optionValue(args, name);
  if (value === undefined) {
    if (name === "actor") {
      throw new Error("missing required option --actor. Use the hook-provided actor id, for example: agentq next --actor <id>");
    }
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

function parseNonNegativeMsOption(
  args: ParsedArgs,
  name: string,
  defaultValue: number,
  commandName: string
): number {
  const value = Number(optionValue(args, name) ?? String(defaultValue));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${commandName} --${name} must be a non-negative number.`);
  }

  return value;
}

function cleanInlineTextValues(args: ParsedArgs, name: string, commandName: string): string[] {
  return optionValues(args, name).map((value) => cleanTextOption(value, name, commandName));
}

async function requiredTextOption(
  args: ParsedArgs,
  name: string,
  runtime: CommandRuntime,
  commandName: string
): Promise<string> {
  const value = await textOption(args, name, runtime, commandName);
  if (value === undefined) {
    throw new Error(`missing required option --${name}`);
  }

  return value;
}

async function textOptionValues(
  args: ParsedArgs,
  name: string,
  runtime: CommandRuntime,
  commandName: string
): Promise<string[]> {
  const values = optionValues(args, name).map((value) => cleanTextOption(value, name, commandName));
  const fileValue = optionValue(args, `${name}-file`);
  const stdinFlag = args.flags.has(`${name}-stdin`);
  const sourceCount = (values.length > 0 ? 1 : 0) + (fileValue === undefined ? 0 : 1) + (stdinFlag ? 1 : 0);
  if (sourceCount > 1) {
    throw new Error(`${commandName} accepts only one --${name}, --${name}-file, or --${name}-stdin source.`);
  }

  if (fileValue !== undefined) {
    return [cleanTextOption(await readTextFile(runtime, fileValue), name, commandName)];
  }

  if (stdinFlag) {
    return [cleanTextOption(await readStdin(), name, commandName)];
  }

  return values;
}

async function textOption(
  args: ParsedArgs,
  name: string,
  runtime: CommandRuntime,
  commandName: string
): Promise<string | undefined> {
  const values = await textOptionValues(args, name, runtime, commandName);
  return values[0];
}

async function readTextFile(runtime: CommandRuntime, filePath: string): Promise<string> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(runtime.cwd, filePath);
  return await readFile(resolved, "utf8");
}

function cleanTextOption(value: string, name: string, commandName: string): string {
  const raw = value.trim();
  const hadDanglingQuote = hasDanglingBoundaryQuote(raw);
  const trimmed = stripDanglingBoundaryQuote(raw);
  if (trimmed.length === 0) {
    throw new Error(`${commandName} --${name} must not be empty.`);
  }

  if (hadDanglingQuote && looksLikeBrokenShellText(trimmed)) {
    throw new Error(
      `${commandName} --${name} looks truncated: ${trimmed}. ` +
      `Use --${name}-file <path> or --${name}-stdin for shell-safe text.`
    );
  }

  return trimmed;
}

function assertRequiredQuestionQuality(question: string): void {
  const questionMarkCount = question.match(/\?/g)?.length ?? 0;
  if (questionMarkCount > 2 || question.length > 1_000) {
    throw new Error(
      "question must ask one required decision. " +
      "Move audits, history, options, and long reports to `agentq note` or project evidence, " +
      "then ask the smallest blocking question."
    );
  }
}

function hasDanglingBoundaryQuote(value: string): boolean {
  if (value.length < 2) {
    return false;
  }

  const first = value[0];
  const last = value[value.length - 1];
  return ((first === "\"" || first === "'") && last !== first) ||
    ((last === "\"" || last === "'") && first !== last);
}

function stripDanglingBoundaryQuote(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" || first === "'") && last !== first) {
    return value.slice(1).trim();
  }

  if ((last === "\"" || last === "'") && first !== last) {
    return value.slice(0, -1).trim();
  }

  return value;
}

function looksLikeBrokenShellText(value: string): boolean {
  if (value.length >= 16) {
    return false;
  }

  return /^["']?[\p{L}\p{N}_-]+$/u.test(value);
}

function pathOptionValues(args: ParsedArgs, name: string): string[] {
  const names = name === "path"
    ? ["path", "paths"]
    : name === "paths"
      ? ["paths", "path"]
      : [name];
  const paths = names.flatMap((candidate) => optionValues(args, candidate))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return paths;
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

  for (const pathValue of paths) {
    assertCliWorkPathQuality(pathValue);
  }

  return paths;
}

function isBroadPathOption(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "." || normalized === "";
}

function assertCliWorkPathQuality(value: string): void {
  if (/["']/.test(value)) {
    throw new Error(
      "AgentQ work path looks malformed: remove shell quotes from the path value and pass each path separately."
    );
  }

  if (value.includes(",")) {
    throw new Error(
      "AgentQ work path looks comma-joined: pass each path as a separate --path value."
    );
  }

  if (/[\r\n]/.test(value)) {
    throw new Error("AgentQ work path cannot contain newlines.");
  }
}

function assertCliQualitativeClosureEvidence(text: string): void {
  if (!looksCliMetricOnlyEvidence(text) || hasCliQualitativeEvidenceCue(text)) {
    return;
  }

  throw new Error(
    "AgentQ work close cannot rely on numeric or scan-only evidence. " +
    "Name the actual output, message/sample, source/log, or behavior that was inspected."
  );
}

function looksCliMetricOnlyEvidence(text: string): boolean {
  return /\b[\w-]+=\d+\b/.test(text) ||
    /\b(?:sections|criteria|stages|forbidden|stale|runrefs|count|score|metric|scan)s?\s*[:=]\s*\d+/i.test(text);
}

function hasCliQualitativeEvidenceCue(text: string): boolean {
  return /\b(?:actual output|actual answer|before\/after|message|sample|dialogue|excerpt|case|source|log|trace|runtime report|build|test|read-back|inspected|observed|reviewed|verified|root cause|owner|artifact|reference|behavior|play loop|experience)\b/i.test(text);
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
  readonly recentWorkAdoptionNudge: RecentWorkAdoptionNudge | null;
}

interface WorkspaceStatusWorkItem {
  readonly pointer: ActiveWorkInventoryItem["pointer"];
  readonly activeWork: WorkState | null;
  readonly actor: WorkspaceStatusActor | null;
}

interface StaleWorkCleanupCandidate {
  readonly item: WorkspaceStatusWorkItem;
  readonly ageMs: number | null;
  readonly reasons: readonly string[];
}

interface StaleWorkCleanupRenderInput {
  readonly mutate: boolean;
  readonly staleAfterMs: number;
  readonly candidates: readonly StaleWorkCleanupCandidate[];
  readonly terminalPointerCount: number;
  readonly abandonedCount: number;
  readonly terminalClearedCount: number;
}

interface RecentWorkAdoptionNudge {
  readonly count: number;
  readonly blockedCount: number;
  readonly unblockedCount: number;
  readonly latestBlockedAt: string | null;
  readonly latestAt: string;
  readonly latestDecision: DiagnosticEvent["decision"] | null;
  readonly latestPaths: readonly string[];
  readonly latestResources: readonly string[];
}

interface WorkspaceKindBreakdown {
  readonly kind: AgentKind;
  readonly total: number;
  readonly active: number;
  readonly stale: number;
  readonly operationalActive: number;
  readonly bookkeepingActive: number;
  readonly routeableActive: number;
  readonly weakActive: number;
  readonly scopeRefreshNeeded: number;
  readonly activeWork: number;
  readonly routeableNoWork: number;
  readonly broadPresenceOnly: number;
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
  readonly agentKind: string;
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
  readonly readOnlyEventCount: number;
  readonly mutatingEventCount: number;
  readonly stopEventCount: number;
  readonly pathfulEventCount: number;
  readonly broadEventCount: number;
  readonly ignoredCommandEventCount: number;
  readonly broadPresenceOnly: boolean;
  readonly paths: readonly string[];
  readonly observedPaths: readonly string[];
  readonly resources: readonly string[];
  readonly summary: string | null;
}

interface DiagnosticAgentActivityRow {
  readonly agentKind: string;
  readonly actorCount: number;
  readonly eventCount: number;
  readonly readOnlyEventCount: number;
  readonly mutatingEventCount: number;
  readonly stopEventCount: number;
  readonly pathfulEventCount: number;
  readonly broadEventCount: number;
  readonly ignoredCommandEventCount: number;
  readonly openWorkCount: number;
  readonly zeroEvidenceOpenWorkCount: number;
  readonly broadPresenceOnlyCount: number;
}

interface DiagnosticActivityRenderInput {
  readonly windowMs: number;
  readonly eventCount: number;
  readonly rowCount: number;
  readonly limit: number;
  readonly agentRows: readonly DiagnosticAgentActivityRow[];
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
  workInventory: readonly WorkspaceStatusWorkItem[],
  nowMs: number,
  staleAfterMs: number,
  recentMessages: readonly RecentMessageSummary[],
  recentOwnerOverlapNudgeCount: number
): string {
  const activeDetails = details.filter((detail) => detail.summary.status === "active");
  const auditOnlyActiveDetails = activeDetails.filter(isAuditOnlyActor);
  const operationalActiveDetails = activeDetails.filter((detail) => !isAuditOnlyActor(detail));
  const workItemsByActor = new Map(workInventory.map((item) => [item.pointer.actorId, item]));
  const activeCount = activeDetails.length;
  const operationalActiveCount = operationalActiveDetails.length;
  const auditOnlyActiveCount = auditOnlyActiveDetails.length;
  const staleCount = details.length - activeCount;
  const pendingInboxCount = details.reduce(
    (count, detail) => count + detail.pendingInbox.length,
    0
  );
  const openWorkItems = workInventory.filter(isOpenWorkInventoryItem);
  const terminalActiveWorkItems = workInventory.filter(isTerminalActiveWorkPointerItem);
  const orphanOpenWorkItems = openWorkItems.filter((item) => item.actor === null);
  const staleOpenWorkItems = openWorkItems.filter((item) => isStaleOpenWorkInventoryItem(item, nowMs, staleAfterMs));
  const zeroEvidenceOpenWorkItems = openWorkItems.filter(
    (item) => item.activeWork !== null && item.activeWork.evidence.length === 0
  );
  const evidencedStaleOpenWorkItems = staleOpenWorkItems.filter(
    (item) => item.activeWork !== null && item.activeWork.evidence.length > 0
  );
  const startedOnlyStaleOpenWorkItems = staleOpenWorkItems.filter(
    (item) => item.activeWork !== null && item.activeWork.eventCount === 1 && item.activeWork.evidence.length === 0
  );
  const nullWorkPointers = workInventory.filter((item) => item.activeWork === null);
  const orphanNullWorkPointers = nullWorkPointers.filter((item) => item.actor === null);
  const openWorkCount = openWorkItems.length;
  const staleOpenWorkCount = staleOpenWorkItems.length;
  const zeroEvidenceOpenWorkCount = zeroEvidenceOpenWorkItems.length;
  const evidencedStaleOpenWorkCount = evidencedStaleOpenWorkItems.length;
  const weakScopeActorCount = details.filter((detail) => detail.weaknesses.length > 0).length;
  const routeableActiveCount = operationalActiveDetails.filter((detail) => detail.weaknesses.length === 0).length;
  const weakActiveCount = operationalActiveDetails.filter((detail) => detail.weaknesses.length > 0).length;
  const scopeRefreshNeededCount = operationalActiveDetails.filter(isScopeRefreshNeededActor).length;
  const noisyPathActorCount = activeDetails.filter(hasNoisyPresencePath).length;
  const activeWorkActorCount = activeDetails.filter(hasOpenActiveWork).length;
  const routeableNoWorkCount = operationalActiveDetails.filter(isRouteableNoWorkActor).length;
  const routeableIdleNoWorkCount = operationalActiveDetails.filter(isRouteableIdleNoWorkActor).length;
  const broadPresenceOnlyCount = activeDetails.filter(isBroadPresenceOnlyActor).length;
  const recentWorkNudgeActorCount = operationalActiveDetails.filter(
    (detail) => detail.recentWorkAdoptionNudge !== null
  ).length;
  const blockedWorkNudgeActorCount = operationalActiveDetails.filter(
    (detail) => (detail.recentWorkAdoptionNudge?.blockedCount ?? 0) > 0
  ).length;
  const resolvedBlockedWorkNudgeActorCount = operationalActiveDetails.filter(
    (detail) =>
      (detail.recentWorkAdoptionNudge?.blockedCount ?? 0) > 0 &&
      (hasOpenActiveWork(detail) || hasRecentWorkAdoptionResolution(detail, workItemsByActor))
  ).length;
  const unresolvedBlockedWorkNudgeActorCount = operationalActiveDetails.filter(
    (detail) =>
      !hasOpenActiveWork(detail) &&
      !hasRecentWorkAdoptionResolution(detail, workItemsByActor) &&
      (detail.recentWorkAdoptionNudge?.blockedCount ?? 0) > 0
  ).length;
  const ignoredWorkNudgeActorCount = operationalActiveDetails.filter(
    (detail) =>
      !hasOpenActiveWork(detail) &&
      !hasRecentWorkAdoptionResolution(detail, workItemsByActor) &&
      (detail.recentWorkAdoptionNudge?.unblockedCount ?? 0) > 0
  ).length;
  const kindBreakdown = buildKindBreakdown(details);
  const doctorIssues = report.checks.filter((check) => check.level !== "ok");
  const operationalActorLines = operationalActiveDetails.map(renderStatusActorLine);
  const auditOnlyActorLines = auditOnlyActiveDetails.map(renderStatusActorLine);
  const openWorkLines = openWorkItems.map(renderStatusWorkInventoryLine);
  const terminalActiveWorkLines = terminalActiveWorkItems.map(renderStatusWorkInventoryLine);
  const orphanOpenWorkLines = orphanOpenWorkItems.map(renderStatusWorkInventoryLine);
  const startedOnlyStaleWorkLines = startedOnlyStaleOpenWorkItems.map(renderStatusWorkInventoryLine);
  const evidencedStaleOpenWorkLines = evidencedStaleOpenWorkItems.map(renderStatusWorkInventoryLine);
  const zeroEvidenceOpenWorkLines = zeroEvidenceOpenWorkItems.map(renderZeroEvidenceWorkInventoryLine);
  const pendingInboxLines = details.flatMap(renderStatusPendingInboxLines);
  const guidanceInput = {
    pendingInboxCount,
    orphanOpenWorkCount: orphanOpenWorkItems.length,
    startedOnlyStaleOpenWorkCount: startedOnlyStaleOpenWorkItems.length,
    routeableActiveCount,
    scopeRefreshNeededCount,
    broadPresenceOnlyCount,
    routeableNoWorkCount,
    routeableIdleNoWorkCount,
    unresolvedBlockedWorkNudgeActorCount,
    ignoredWorkNudgeActorCount,
    recentMessageCount: recentMessages.length,
    staleOpenWorkCount,
    evidencedStaleOpenWorkCount,
    zeroEvidenceOpenWorkCount,
    terminalActiveWorkPointerCount: terminalActiveWorkItems.length
  };
  const signalLines = statusSignals(guidanceInput);

  const lines = [
    "AgentQ status",
    `Workspace: ${report.workspaceRoot}`,
    `Runtime store: ${report.storePath}`,
    `doctor: ${report.summary}`,
    `actors: ${details.length} (active ${activeCount}, stale ${staleCount}, staleAfter ${formatDuration(staleAfterMs)})`,
    `operational active actors: ${operationalActiveCount}`,
    `audit/bookkeeping active actors: ${auditOnlyActiveCount}`,
    `routeable active actors: ${routeableActiveCount}`,
    `broad/generic active actors: ${weakActiveCount}`,
    `scope-refresh-needed actors: ${scopeRefreshNeededCount}`,
    `active work actors: ${activeWorkActorCount}`,
    `routeable no-work actors: ${routeableNoWorkCount}`,
    `routeable idle actors: ${routeableIdleNoWorkCount}`,
    `recent work-adoption nudged actors: ${recentWorkNudgeActorCount}`,
    `blocked work-adoption attempts: ${blockedWorkNudgeActorCount}`,
    `resolved blocked work-adoption attempts: ${resolvedBlockedWorkNudgeActorCount}`,
    `unresolved blocked work-adoption attempts: ${unresolvedBlockedWorkNudgeActorCount}`,
    `ignored work-adoption nudges: ${ignoredWorkNudgeActorCount}`,
    `owner-overlap nudges 24h: ${recentOwnerOverlapNudgeCount}`,
    `broad presence-only actors: ${broadPresenceOnlyCount}`,
    `legacy/noisy path actors: ${noisyPathActorCount}`,
    `pending inbox: ${pendingInboxCount}`,
    `open work: ${openWorkCount}`,
    `orphan open work: ${orphanOpenWorkItems.length}`,
    `stale open work: ${staleOpenWorkCount}`,
    `evidenced stale open work: ${evidencedStaleOpenWorkCount}`,
    `zero-evidence open work: ${zeroEvidenceOpenWorkCount}`,
    `started-only stale work: ${startedOnlyStaleOpenWorkItems.length}`,
    `terminal active work pointers: ${terminalActiveWorkItems.length}`,
    `null work pointers: ${nullWorkPointers.length}`,
    `orphan null work pointers: ${orphanNullWorkPointers.length}`,
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

  if (kindBreakdown.length > 0) {
    lines.push(
      "",
      "Actor breakdown:",
      ...kindBreakdown.map(renderKindBreakdownLine)
    );
  }

  lines.push(
    "",
    "Next:",
    `  ${statusNextAction(guidanceInput)}`
  );

  if (signalLines.length > 0) {
    lines.push(
      "",
      "Signals:",
      ...signalLines.map((line) => `  ${line}`)
    );
  }

  lines.push(
    "",
    "Operational active actors:",
    ...(operationalActorLines.length === 0 ? ["  none"] : operationalActorLines),
    "",
    "Audit/bookkeeping active actors:",
    ...(auditOnlyActorLines.length === 0 ? ["  none"] : auditOnlyActorLines),
    "",
    "Open work:",
    ...(openWorkLines.length === 0 ? ["  none"] : openWorkLines),
    "",
    "Terminal active work pointers:",
    ...(terminalActiveWorkLines.length === 0 ? ["  none"] : terminalActiveWorkLines),
    "",
    "Orphan open work:",
    ...(orphanOpenWorkLines.length === 0 ? ["  none"] : orphanOpenWorkLines),
    "",
    "Started-only stale work:",
    ...(startedOnlyStaleWorkLines.length === 0 ? ["  none"] : startedOnlyStaleWorkLines),
    "",
    "Evidenced stale open work:",
    ...(evidencedStaleOpenWorkLines.length === 0 ? ["  none"] : evidencedStaleOpenWorkLines),
    "",
    "Zero-evidence open work:",
    ...(zeroEvidenceOpenWorkLines.length === 0 ? ["  none"] : zeroEvidenceOpenWorkLines),
    "",
    "Pending inbox:",
    ...(pendingInboxLines.length === 0 ? ["  none"] : pendingInboxLines)
  );

  return `${lines.join("\n")}\n`;
}

function buildKindBreakdown(details: readonly WorkspaceStatusActor[]): WorkspaceKindBreakdown[] {
  const rows = new Map<AgentKind, WorkspaceKindBreakdown>();
  for (const detail of details) {
    const kind = detail.summary.actor.kind;
    const existing = rows.get(kind) ?? emptyKindBreakdown(kind);
    const active = detail.summary.status === "active";
    const operationalActive = active && !isAuditOnlyActor(detail);
    const weakActive = operationalActive && detail.weaknesses.length > 0;
    rows.set(kind, {
      kind,
      total: existing.total + 1,
      active: existing.active + (active ? 1 : 0),
      stale: existing.stale + (active ? 0 : 1),
      operationalActive: existing.operationalActive + (operationalActive ? 1 : 0),
      bookkeepingActive: existing.bookkeepingActive + (active && isAuditOnlyActor(detail) ? 1 : 0),
      routeableActive: existing.routeableActive + (operationalActive && detail.weaknesses.length === 0 ? 1 : 0),
      weakActive: existing.weakActive + (weakActive ? 1 : 0),
      scopeRefreshNeeded: existing.scopeRefreshNeeded + (isScopeRefreshNeededActor(detail) ? 1 : 0),
      activeWork: existing.activeWork + (active && hasOpenActiveWork(detail) ? 1 : 0),
      routeableNoWork: existing.routeableNoWork + (isRouteableNoWorkActor(detail) ? 1 : 0),
      broadPresenceOnly: existing.broadPresenceOnly + (isBroadPresenceOnlyActor(detail) ? 1 : 0)
    });
  }

  return ["codex", "claude-code", "copilot-cli", "custom"]
    .map((kind) => rows.get(kind as AgentKind))
    .filter((row): row is WorkspaceKindBreakdown => row !== undefined);
}

function emptyKindBreakdown(kind: AgentKind): WorkspaceKindBreakdown {
  return {
    kind,
    total: 0,
    active: 0,
    stale: 0,
    operationalActive: 0,
    bookkeepingActive: 0,
    routeableActive: 0,
    weakActive: 0,
    scopeRefreshNeeded: 0,
    activeWork: 0,
    routeableNoWork: 0,
    broadPresenceOnly: 0
  };
}

function isRouteableNoWorkActor(detail: WorkspaceStatusActor): boolean {
  return (
    detail.summary.status === "active" &&
    !isAuditOnlyActor(detail) &&
    detail.weaknesses.length === 0 &&
    detail.activeWork === null
  );
}

function isRouteableIdleNoWorkActor(detail: WorkspaceStatusActor): boolean {
  return isRouteableNoWorkActor(detail) && detail.recentWorkAdoptionNudge === null;
}

function isBroadPresenceOnlyActor(detail: WorkspaceStatusActor): boolean {
  return (
    detail.summary.status === "active" &&
    detail.weaknesses.length > 0 &&
    detail.weaknesses.every(isBookkeepingScopeWeakness) &&
    detail.pendingInbox.length === 0 &&
    detail.activeWork === null &&
    detail.recentWorkAdoptionNudge === null
  );
}

function isScopeRefreshNeededActor(detail: WorkspaceStatusActor): boolean {
  return (
    detail.summary.status === "active" &&
    !isAuditOnlyActor(detail) &&
    detail.weaknesses.length > 0 &&
    !isBroadPresenceOnlyActor(detail)
  );
}

function isAuditOnlyActor(detail: WorkspaceStatusActor): boolean {
  return (
    detail.summary.status === "active" &&
    isBookkeepingPresence(detail.summary.actor) &&
    detail.pendingInbox.length === 0 &&
    detail.activeWork === null &&
    detail.recentWorkAdoptionNudge === null
  );
}

function hasOpenActiveWork(detail: WorkspaceStatusActor): boolean {
  return detail.activeWork?.status === "open";
}

function hasNoisyPresencePath(detail: WorkspaceStatusActor): boolean {
  return detail.weaknesses.some((weakness) => weakness.kind === "noisy_path");
}

function hasRecentWorkAdoptionResolution(
  detail: WorkspaceStatusActor,
  workItemsByActor: ReadonlyMap<string, WorkspaceStatusWorkItem>
): boolean {
  const nudge = detail.recentWorkAdoptionNudge;
  if (nudge === null) {
    return false;
  }

  const item = workItemsByActor.get(detail.summary.actor.actorId);
  if (item === undefined) {
    return false;
  }

  return nudge.latestBlockedAt === null
    ? timestampAtOrAfter(item.pointer.updatedAt, nudge.latestAt)
    : timestampAtOrAfter(item.pointer.updatedAt, nudge.latestBlockedAt);
}

function isBookkeepingScopeWeakness(weakness: WorkspaceStatusActor["weaknesses"][number]): boolean {
  return weakness.kind === "broad_path" || weakness.kind === "generic_responsibility";
}

function renderKindBreakdownLine(row: WorkspaceKindBreakdown): string {
  return [
    `  ${row.kind}: total ${row.total}`,
    `active ${row.active}`,
    `stale ${row.stale}`,
    `operational-active ${row.operationalActive}`,
    `bookkeeping-active ${row.bookkeepingActive}`,
    `routeable ${row.routeableActive}`,
    `broad/generic ${row.weakActive}`,
    `scope-refresh-needed ${row.scopeRefreshNeeded}`,
    `active-work ${row.activeWork}`,
    `routeable-no-work ${row.routeableNoWork}`,
    `broad-presence-only ${row.broadPresenceOnly}`
  ].join(", ");
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
      const hasOpenWork = activeWork?.status === "open";
      const lastEventMs = eventTimes[eventTimes.length - 1];
      const lastSeenMs = actor === undefined ? Number.NaN : Date.parse(actor.lastSeen);
      const workAdoptionNudgeEvents = actorEvents.filter(eventHasWorkAdoptionNudge);
      const readOnlyEvents = actorEvents.filter((event) => event.toolMode === "read-only");
      const mutatingEvents = actorEvents.filter((event) => event.toolMode === "mutating");
      const stopEvents = actorEvents.filter((event) => event.toolMode === "stop" || event.event === "stop");
      const pathfulEvents = actorEvents.filter(eventHasSpecificDiagnosticScope);
      const ignoredCommandEvents = actorEvents.filter((event) => (event.ignoredCommands ?? []).length > 0);
      const broadPresenceOnly = actor !== undefined &&
        !hasOpenWork &&
        workAdoptionNudgeEvents.length === 0 &&
        actorScopeWeaknesses(actor).length > 0 &&
        actorEvents.length <= 1;

      return {
        actorId,
        agentKind: diagnosticAgentKind(actor, actorEvents),
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
        hasOpenWork,
        openWorkEvidenceCount: activeWork?.evidence.length ?? null,
        openWorkTitle: activeWork?.title ?? null,
        readOnlyEventCount: readOnlyEvents.length,
        mutatingEventCount: mutatingEvents.length,
        stopEventCount: stopEvents.length,
        pathfulEventCount: pathfulEvents.length,
        broadEventCount: actorEvents.length - pathfulEvents.length,
        ignoredCommandEventCount: ignoredCommandEvents.length,
        broadPresenceOnly,
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

function buildDiagnosticAgentActivityRows(rows: readonly DiagnosticActivityRow[]): DiagnosticAgentActivityRow[] {
  const byKind = new Map<string, DiagnosticAgentActivityRow>();
  for (const row of rows) {
    const existing = byKind.get(row.agentKind) ?? emptyDiagnosticAgentActivityRow(row.agentKind);
    byKind.set(row.agentKind, {
      agentKind: row.agentKind,
      actorCount: existing.actorCount + 1,
      eventCount: existing.eventCount + row.eventCount,
      readOnlyEventCount: existing.readOnlyEventCount + row.readOnlyEventCount,
      mutatingEventCount: existing.mutatingEventCount + row.mutatingEventCount,
      stopEventCount: existing.stopEventCount + row.stopEventCount,
      pathfulEventCount: existing.pathfulEventCount + row.pathfulEventCount,
      broadEventCount: existing.broadEventCount + row.broadEventCount,
      ignoredCommandEventCount: existing.ignoredCommandEventCount + row.ignoredCommandEventCount,
      openWorkCount: existing.openWorkCount + (row.hasOpenWork ? 1 : 0),
      zeroEvidenceOpenWorkCount: existing.zeroEvidenceOpenWorkCount + (row.openWorkEvidenceCount === 0 ? 1 : 0),
      broadPresenceOnlyCount: existing.broadPresenceOnlyCount + (row.broadPresenceOnly ? 1 : 0)
    });
  }

  return [...byKind.values()]
    .sort((left, right) =>
      agentKindOrder(left.agentKind) - agentKindOrder(right.agentKind) ||
      right.eventCount - left.eventCount ||
      left.agentKind.localeCompare(right.agentKind)
    );
}

function emptyDiagnosticAgentActivityRow(agentKind: string): DiagnosticAgentActivityRow {
  return {
    agentKind,
    actorCount: 0,
    eventCount: 0,
    readOnlyEventCount: 0,
    mutatingEventCount: 0,
    stopEventCount: 0,
    pathfulEventCount: 0,
    broadEventCount: 0,
    ignoredCommandEventCount: 0,
    openWorkCount: 0,
    zeroEvidenceOpenWorkCount: 0,
    broadPresenceOnlyCount: 0
  };
}

function diagnosticAgentKind(actor: Presence | undefined, events: readonly DiagnosticEvent[]): string {
  if (actor !== undefined) {
    return actor.kind;
  }

  const latestAdapter = [...events].reverse().find((event) => event.adapter !== undefined)?.adapter;
  return latestAdapter ?? "unknown";
}

function eventHasSpecificDiagnosticScope(event: DiagnosticEvent): boolean {
  return (event.paths ?? []).some(isSpecificDiagnosticPath) || (event.resources ?? []).length > 0;
}

function agentKindOrder(kind: string): number {
  const order = ["codex", "claude-code", "copilot-cli", "custom", "unknown"];
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}

function statusSignals(input: {
  readonly pendingInboxCount: number;
  readonly orphanOpenWorkCount: number;
  readonly startedOnlyStaleOpenWorkCount: number;
  readonly routeableActiveCount: number;
  readonly scopeRefreshNeededCount: number;
  readonly broadPresenceOnlyCount: number;
  readonly routeableNoWorkCount: number;
  readonly routeableIdleNoWorkCount: number;
  readonly unresolvedBlockedWorkNudgeActorCount: number;
  readonly ignoredWorkNudgeActorCount: number;
  readonly recentMessageCount: number;
  readonly staleOpenWorkCount: number;
  readonly evidencedStaleOpenWorkCount: number;
  readonly zeroEvidenceOpenWorkCount: number;
  readonly terminalActiveWorkPointerCount: number;
}): string[] {
  const lines: string[] = [];
  const staleOpenWorkWithoutEvidence = input.staleOpenWorkCount - input.evidencedStaleOpenWorkCount;

  if (input.pendingInboxCount > 0) {
    lines.push(`pending-inbox: ${input.pendingInboxCount} required item(s) still need a response.`);
  }

  if (input.orphanOpenWorkCount > 0) {
    lines.push(`orphan-open-work: ${input.orphanOpenWorkCount} open work item(s) have no actor presence.`);
  }

  if (input.startedOnlyStaleOpenWorkCount > 0) {
    lines.push(`started-only-stale-work: ${input.startedOnlyStaleOpenWorkCount} item(s) look like interrupted sessions or smoke residue.`);
  }

  if (input.terminalActiveWorkPointerCount > 0) {
    lines.push(`terminal-active-pointer: ${input.terminalActiveWorkPointerCount} pointer(s) still reference closed work.`);
  }

  if (input.unresolvedBlockedWorkNudgeActorCount > 0) {
    lines.push(`work-adoption-blocked: ${input.unresolvedBlockedWorkNudgeActorCount} actor(s) still have unresolved blocked mutating attempts.`);
  }

  if (input.ignoredWorkNudgeActorCount > 0) {
    lines.push(`work-adoption: ${input.ignoredWorkNudgeActorCount} actor(s) received edit nudges without active work.`);
  }

  if (input.scopeRefreshNeededCount > 0) {
    lines.push(`scope-refresh: ${input.scopeRefreshNeededCount} weak-scoped actor(s) also have inbox, work, nudges, or noisy paths.`);
  }

  if (input.broadPresenceOnlyCount > 0) {
    lines.push(`bookkeeping-presence: ${input.broadPresenceOnlyCount} broad presence-only actor(s) are audit/session context.`);
  }

  if (input.routeableIdleNoWorkCount > 0) {
    lines.push(`routeable-idle: ${input.routeableIdleNoWorkCount} routeable actor(s) are idle/read-only without active work.`);
  }

  if (input.routeableActiveCount > 1 && input.recentMessageCount === 0) {
    lines.push(`coordination: ${input.routeableActiveCount} routeable active actor(s), but no recent inter-agent messages.`);
  }

  if (input.evidencedStaleOpenWorkCount > 0) {
    lines.push(`evidenced-stale-open-work: ${input.evidencedStaleOpenWorkCount} open work item(s) have context evidence and are past the stale window; review or close with final verification.`);
  }

  if (staleOpenWorkWithoutEvidence > 0) {
    lines.push(`stale-open-work: ${staleOpenWorkWithoutEvidence} open work item(s) are past the stale window without context evidence.`);
  }

  if (input.zeroEvidenceOpenWorkCount > 0) {
    lines.push(`zero-evidence-work: ${input.zeroEvidenceOpenWorkCount} open work item(s) have no context evidence.`);
  }

  return lines;
}

function statusNextAction(input: {
  readonly pendingInboxCount: number;
  readonly orphanOpenWorkCount: number;
  readonly startedOnlyStaleOpenWorkCount: number;
  readonly scopeRefreshNeededCount: number;
  readonly terminalActiveWorkPointerCount: number;
  readonly unresolvedBlockedWorkNudgeActorCount: number;
  readonly ignoredWorkNudgeActorCount: number;
  readonly routeableIdleNoWorkCount: number;
  readonly zeroEvidenceOpenWorkCount: number;
  readonly staleOpenWorkCount: number;
  readonly evidencedStaleOpenWorkCount: number;
  readonly routeableActiveCount: number;
  readonly recentMessageCount: number;
}): string {
  if (input.pendingInboxCount > 0) {
    return "Resolve pending inbox first with `agentq next --actor <id>` for the affected actor.";
  }

  if (input.orphanOpenWorkCount > 0) {
    return "Preview stale started-only cleanup with `agentq work cleanup-stale`; apply with `--yes` only after reviewing the candidates.";
  }

  if (input.startedOnlyStaleOpenWorkCount > 0) {
    return "Preview started-only stale work with `agentq work cleanup-stale`; inspect any non-candidate stale work manually.";
  }

  if (input.terminalActiveWorkPointerCount > 0) {
    return "Preview terminal pointer residue with `agentq work cleanup-stale`; apply with `--yes` to clear closed active pointers.";
  }

  if (input.unresolvedBlockedWorkNudgeActorCount > 0) {
    return "Start active work for actors with blocked mutating attempts, then retry the blocked tool.";
  }

  if (input.ignoredWorkNudgeActorCount > 0) {
    return "Start active work for actors that already received concrete edit nudges with `agentq next --actor <id>`.";
  }

  if (input.scopeRefreshNeededCount > 0) {
    return "Refresh weak-scoped actors that have inbox/work/nudges with `agentq next --actor <id>`.";
  }

  if (input.routeableIdleNoWorkCount > 0) {
    return "No urgent action for idle routeable actors; run `agentq next --actor <id>` before their next edit or handoff.";
  }

  if (input.zeroEvidenceOpenWorkCount > 0) {
    return "Record collaboration context on open work through `agentq next --actor <id>` before any final answer.";
  }

  if (input.evidencedStaleOpenWorkCount > 0) {
    return "Review evidenced stale open work and close it with final verification, or refresh evidence if the work is still active.";
  }

  if (input.staleOpenWorkCount > 0) {
    return "Review stale open work through `agentq next --actor <id>` and close only with ownership evidence.";
  }

  if (input.routeableActiveCount > 1 && input.recentMessageCount === 0) {
    return "Before shared edits, run `agentq owners --path <path>` or `--resource <resource>` and route a question/block on overlap.";
  }

  return "No urgent AgentQ action; use `agentq next --actor <id>` before final, and `agentq owners ...` before shared edits.";
}

function findRecentWorkAdoptionNudge(
  events: readonly DiagnosticEvent[],
  actorId: string,
  nowMs: number,
  windowMs: number
): RecentWorkAdoptionNudge | null {
  const matches = events
    .filter((event) => {
      const atMs = Date.parse(event.at);
      return event.actorId === actorId &&
        eventHasWorkAdoptionNudge(event) &&
        Number.isFinite(nowMs) &&
        Number.isFinite(atMs) &&
        nowMs - atMs >= 0 &&
        nowMs - atMs <= windowMs;
    })
    .sort((left, right) => right.at.localeCompare(left.at));
  const latest = matches[0];
  if (latest === undefined) {
    return null;
  }
  const blockedMatches = matches.filter((event) => event.decision === "block");

  return {
    count: matches.length,
    blockedCount: blockedMatches.length,
    unblockedCount: matches.filter((event) => event.decision !== "block").length,
    latestBlockedAt: latestDiagnosticEventAt(blockedMatches),
    latestAt: latest.at,
    latestDecision: latest.decision ?? null,
    latestPaths: latest.paths ?? [],
    latestResources: latest.resources ?? []
  };
}

function latestDiagnosticEventAt(events: readonly DiagnosticEvent[]): string | null {
  return events.reduce<string | null>(
    (latest, event) => latest === null || event.at > latest ? event.at : latest,
    null
  );
}

function timestampAtOrAfter(value: string, minimum: string): boolean {
  const valueMs = Date.parse(value);
  const minimumMs = Date.parse(minimum);
  return Number.isFinite(valueMs) &&
    Number.isFinite(minimumMs) &&
    valueMs >= minimumMs;
}

function eventHasWorkAdoptionNudge(event: DiagnosticEvent): boolean {
  const nudgeKinds = event.nudgeKinds ?? [];
  if (event.nudgeKinds !== undefined) {
    return nudgeKinds.includes("work-adoption");
  }

  if (nudgeKinds.includes("work-adoption")) {
    return true;
  }

  return event.nudge === true &&
    ((event.paths ?? []).some(isSpecificDiagnosticPath) || (event.resources ?? []).length > 0);
}

function eventHasOwnerOverlapNudge(event: DiagnosticEvent): boolean {
  return event.nudgeKinds?.includes("owner-overlap") === true;
}

function countRecentOwnerOverlapNudges(
  events: readonly DiagnosticEvent[],
  nowMs: number,
  windowMs: number
): number {
  return events.filter((event) => {
    const atMs = Date.parse(event.at);
    return eventHasOwnerOverlapNudge(event) &&
      Number.isFinite(nowMs) &&
      Number.isFinite(atMs) &&
      nowMs - atMs >= 0 &&
      nowMs - atMs <= windowMs;
  }).length;
}

function isSpecificDiagnosticPath(value: string): boolean {
  return value.trim().length > 0 && value.trim() !== "." && !isNoisyPresencePath(value);
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
        event.toolMode === undefined ? undefined : `mode:${event.toolMode}`,
        event.paths === undefined ? undefined : `paths:${formatList(event.paths)}`,
        event.resources === undefined ? undefined : `resources:${formatList(event.resources)}`,
        event.ignoredCommands === undefined || event.ignoredCommands.length === 0
          ? undefined
          : `ignored:${event.ignoredCommands.length}`,
        event.nudge === undefined ? undefined : `nudge:${event.nudge ? "yes" : "no"}`,
        event.nudgeKinds === undefined || event.nudgeKinds.length === 0
          ? undefined
          : `nudgeKinds:${formatList(event.nudgeKinds)}`,
        event.decision === undefined ? undefined : `decision:${event.decision}`
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
    "Evidence boundary:",
    "  Activity counts are routing telemetry, not answer-quality proof.",
    "  Quality claims need actual message/request/response text or same-prompt before/after outputs.",
    "",
    "Agents:",
    ...(input.agentRows.length === 0 ? ["  none"] : input.agentRows.map(renderDiagnosticAgentActivityRow)),
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
        `agent:${row.agentKind}`,
        `events:${row.eventCount}`,
        `lastEvent:${formatNullableDuration(row.lastEventAgeMs)}`,
        `maxGap:${formatNullableDuration(row.maxGapMs)}`,
        `p95Gap:${formatNullableDuration(row.p95GapMs)}`,
        `avgGap:${formatNullableDuration(row.avgGapMs)}`,
        `lastSeen:${formatNullableDuration(row.lastSeenAgeMs)}`,
        `inbox:${row.pendingInboxCount}`,
        `work:${row.hasOpenWork ? "open" : "none"}`,
        row.openWorkEvidenceCount === 0 ? "zero-evidence" : undefined,
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

function renderDiagnosticAgentActivityRow(row: DiagnosticAgentActivityRow): string {
  return [
    `  ${row.agentKind}: actors:${row.actorCount}`,
    `events:${row.eventCount}`,
    `readOnly:${row.readOnlyEventCount}`,
    `mutating:${row.mutatingEventCount}`,
    `stop:${row.stopEventCount}`,
    `pathful:${row.pathfulEventCount}`,
    `broad:${row.broadEventCount}`,
    `ignoredCmdEvents:${row.ignoredCommandEventCount}`,
    `openWork:${row.openWorkCount}`,
    `zeroEvidenceWork:${row.zeroEvidenceOpenWorkCount}`,
    `broadPresenceOnly:${row.broadPresenceOnlyCount}`
  ].join(" | ");
}

function renderStatusActorLine(detail: WorkspaceStatusActor): string {
  const actor = detail.summary.actor;
  return [
    `  ${actor.actorId}`,
    `age ${detail.summary.ageMs === null ? "unknown" : formatDuration(detail.summary.ageMs)}`,
    `paths: ${formatList(actor.activePaths)}`,
    ...(actor.observedPaths === undefined ? [] : [`observing: ${formatList(actor.observedPaths)}`]),
    ...(actor.activeResources === undefined ? [] : [`resources: ${formatList(actor.activeResources)}`]),
    ...(detail.weaknesses.length === 0
      ? []
      : [`scopeIssues: ${formatList(detail.weaknesses.map((weakness) => `${weakness.kind}:${weakness.detail}`))}`]),
    `responsibilities: ${formatList(actor.responsibilities)}`
  ].join(" | ");
}

function isOpenWorkInventoryItem(item: WorkspaceStatusWorkItem): boolean {
  return item.activeWork?.status === "open";
}

function isTerminalActiveWorkPointerItem(item: WorkspaceStatusWorkItem): boolean {
  return item.activeWork !== null && item.activeWork.status !== "open";
}

function isStaleOpenWorkInventoryItem(
  item: WorkspaceStatusWorkItem,
  nowMs: number,
  staleAfterMs: number
): boolean {
  if (item.activeWork?.status !== "open") {
    return false;
  }
  if (item.actor !== null) {
    return item.actor.summary.status === "stale";
  }

  const updatedAtMs = Date.parse(item.activeWork.updatedAt);
  return Number.isFinite(nowMs) &&
    Number.isFinite(updatedAtMs) &&
    Math.max(0, nowMs - updatedAtMs) > staleAfterMs;
}

function collectStartedOnlyStaleWorkCleanupCandidates(
  workInventory: readonly WorkspaceStatusWorkItem[],
  nowMs: number,
  staleAfterMs: number
): StaleWorkCleanupCandidate[] {
  return workInventory.flatMap((item) => {
    const work = item.activeWork;
    if (
      work === null ||
      work.status !== "open" ||
      work.eventCount !== 1 ||
      work.evidence.length !== 0 ||
      !isStaleOpenWorkInventoryItem(item, nowMs, staleAfterMs)
    ) {
      return [];
    }

    const updatedAtMs = Date.parse(work.updatedAt);
    const ageMs = Number.isFinite(nowMs) && Number.isFinite(updatedAtMs)
      ? Math.max(0, nowMs - updatedAtMs)
      : null;
    return [{
      item,
      ageMs,
      reasons: [
        "started-only",
        "zero evidence",
        item.actor === null ? "missing actor presence" : "stale actor presence",
        ...(ageMs === null ? [] : [`work age ${formatDuration(ageMs)}`])
      ]
    }];
  });
}

function renderStaleWorkCleanupResult(input: StaleWorkCleanupRenderInput): string {
  const lines = [
    "AgentQ stale work cleanup",
    `Mode: ${input.mutate ? "applied" : "dry-run"}`,
    `staleAfter: ${formatDuration(input.staleAfterMs)}`,
    `candidates: ${input.candidates.length}`,
    `abandoned: ${input.abandonedCount}`,
    `terminal pointers: ${input.terminalPointerCount}`,
    `terminal pointers cleared: ${input.terminalClearedCount}`,
    "",
    "Candidates:",
    ...(input.candidates.length === 0
      ? ["  none"]
      : input.candidates.map(renderStaleWorkCleanupCandidate))
  ];

  if (!input.mutate && (input.candidates.length > 0 || input.terminalPointerCount > 0)) {
    lines.push(
      "",
      "Next:",
      "  Run `agentq work cleanup-stale --yes` to abandon started-only stale work with evidence and clear terminal pointer residue."
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderStaleWorkCleanupCandidate(candidate: StaleWorkCleanupCandidate): string {
  const work = candidate.item.activeWork;
  return [
    `  ${work?.workId ?? "(no active work)"}`,
    `actor: ${candidate.item.pointer.actorId}`,
    `actorPresence: ${candidate.item.actor === null ? "missing" : candidate.item.actor.summary.status}`,
    ...(work === null
      ? []
      : [
        `updated: ${work.updatedAt}`,
        `title: ${work.title}`
      ]),
    `reason: ${candidate.reasons.join(", ")}`
  ].join(" | ");
}

function renderStaleWorkCleanupEvidence(candidate: StaleWorkCleanupCandidate, now: string): string {
  const work = candidate.item.activeWork;
  const actorPresence = candidate.item.actor === null ? "missing" : candidate.item.actor.summary.status;
  return [
    `Cleanup review at ${now}: classified stale started-only work as residue.`,
    `Actor presence: ${actorPresence}.`,
    `Events: ${work?.eventCount ?? 0}.`,
    `Prior evidence: ${work?.evidence.length ?? 0}.`,
    `Reasons: ${candidate.reasons.join(", ")}.`
  ].join(" ");
}

function renderStatusWorkInventoryLine(item: WorkspaceStatusWorkItem): string {
  const work = item.activeWork;
  return [
    `  ${work?.workId ?? "(no active work)"}`,
    `actor: ${item.pointer.actorId}`,
    `actorPresence: ${item.actor === null ? "missing" : item.actor.summary.status}`,
    `pointerUpdated: ${item.pointer.updatedAt}`,
    ...(work === null
      ? [`pointer: ${item.pointer.activeWorkId === null ? "null" : item.pointer.activeWorkId}`]
      : [
        `status: ${work.status}`,
        `title: ${work.title}`,
        `events: ${work.eventCount}`,
        `evidence: ${work.evidence.length}`
      ]),
    ...(work !== null && work.evidence.length === 0 && item.actor !== null
      ? [`next: agentq next --actor ${item.pointer.actorId}`]
      : [])
  ].join(" | ");
}

function renderZeroEvidenceWorkInventoryLine(item: WorkspaceStatusWorkItem): string {
  const work = item.activeWork;
  return [
    `  ${work?.workId ?? item.pointer.activeWorkId ?? "(null)"}`,
    `actor: ${item.pointer.actorId}`,
    `actorPresence: ${item.actor === null ? "missing" : item.actor.summary.status}`,
    ...(work === null
      ? ["pointer: null"]
      : [
        `title: ${work.title}`,
        `events: ${work.eventCount}`,
        `updated: ${work.updatedAt}`
      ]),
    ...(item.actor === null ? ["next: inspect or abandon stale work pointer with evidence"] : [`next: agentq next --actor ${item.pointer.actorId}`])
  ].join(" | ");
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

  return `broad; run agentq next --actor ${actor.actorId} for the exact scope refresh command`;
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

function renderWorkStackStatus(actorId: string, stack: readonly WorkState[]): string {
  const current = stack[stack.length - 1];
  if (current === undefined) {
    return `no active work for ${actorId}\n`;
  }

  const lines = [
    `work stack for ${actorId}`,
    ...renderWorkStackLines(stack, "Stack"),
    "",
    `current: ${current.workId}`,
    `  status: ${current.status}`,
    `  title: ${current.title}`,
    `  objective: ${current.spec.objective}`,
    `  spec: ${current.specStatus}`,
    `  touched: ${current.touchedPaths.join(", ")}`,
    `  evidence: ${current.evidence.length}`
  ];
  lines.push(...renderWorkSpecDetailLines(current, "  "));

  if (current.status === "open" && current.evidence.length === 0) {
    lines.push(`  next: record collaboration context now: agentq work evidence --actor ${current.actorId} --evidence "Context: current frame; observed basis; touched paths/resources; next pass check"`);
  } else if (current.status === "open") {
    lines.push("  next: add missing final evidence or close with summary when the frame is actually done");
  }

  return `${lines.join("\n")}\n`;
}

function renderWorkStackLines(stack: readonly WorkState[], label: string): string[] {
  if (stack.length <= 1) {
    return [];
  }

  return [
    `${label}:`,
    ...stack.map((frame, index) => {
      const marker = index === stack.length - 1 ? "current" : "parent";
      const obsolete = frame.specStatus === "legacy-obsolete" ? ", obsolete" : "";
      return `  ${index + 1}. ${frame.workId} [${marker}] ${frame.title} -> ${frame.spec.objective} (evidence ${frame.evidence.length}${obsolete})`;
    })
  ];
}

function renderCompactWorkContextLines(stack: readonly WorkState[]): string[] {
  const current = stack[stack.length - 1];
  if (current === undefined) {
    return [];
  }

  const top = stack[0] ?? current;
  return [
    "Work context:",
    `  top-objective: ${top.spec.objective}`,
    ...(top.spec.denominator === undefined ? [] : [`  parent-denominator: ${top.spec.denominator.join("; ")}`]),
    ...(top.spec.passCriteria === undefined ? [] : [`  parent-pass: ${top.spec.passCriteria.join("; ")}`]),
    `  current-objective: ${current.spec.objective}`,
    ...(current.spec.slice === undefined ? [] : [`  current-slice: ${current.spec.slice}`]),
    ...(current.spec.passCriteria === undefined ? [] : [`  current-pass: ${current.spec.passCriteria.join("; ")}`]),
    ...(current.spec.nextOperation === undefined ? [] : [`  next-operation: ${current.spec.nextOperation}`]),
    ...(current.spec.stopCondition === undefined ? [] : [`  stop-condition: ${current.spec.stopCondition}`])
  ];
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function renderWorkState(
  label: string,
  work: WorkState,
  options: { readonly returnStack?: readonly WorkState[] } = {}
): string {
  const lines = [
    `${label}: ${work.workId}`,
    `  actor: ${work.actorId}`,
    `  status: ${work.status}`,
    `  title: ${work.title}`,
    `  objective: ${work.spec.objective}`,
    `  spec: ${work.specStatus}`,
    `  touched: ${work.touchedPaths.join(", ")}`,
    `  evidence: ${work.evidence.length}`
  ];
  lines.push(...renderWorkSpecDetailLines(work, "  "));
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
  const returnStack = options.returnStack ?? [];
  const returned = returnStack[returnStack.length - 1];
  if (returned !== undefined) {
    lines.push(
      "",
      `returned to parent: ${returned.workId}`,
      `  objective: ${returned.spec.objective}`,
      `  evidence: ${returned.evidence.length}`,
      ...renderWorkSpecDetailLines(returned, "  "),
      "  required: record parent-return evidence that mentions the restored parent denominator/pass/next/objective before closing this frame",
      ...(returned.spec.nextOperation === undefined ? [] : [`  next: ${returned.spec.nextOperation}`]),
      ...renderWorkStackLines(returnStack, "Return stack")
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderWorkSpecDetailLines(work: WorkState, indent: string): string[] {
  const lines: string[] = [];
  if (work.spec.slice !== undefined) {
    lines.push(`${indent}slice: ${work.spec.slice}`);
  }
  if (work.spec.denominator !== undefined) {
    lines.push(`${indent}denominator: ${work.spec.denominator.join("; ")}`);
  }
  if (work.spec.passCriteria !== undefined) {
    lines.push(`${indent}pass: ${work.spec.passCriteria.join("; ")}`);
  }
  if (work.spec.nextOperation !== undefined) {
    lines.push(`${indent}next-operation: ${work.spec.nextOperation}`);
  }
  if (work.spec.stopCondition !== undefined) {
    lines.push(`${indent}stop-condition: ${work.spec.stopCondition}`);
  }
  if (work.obsoleteReason !== null) {
    lines.push(`${indent}obsolete: ${work.obsoleteReason}`);
  }
  return lines;
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
