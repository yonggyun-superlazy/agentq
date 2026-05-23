import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const AGENTQ_MARKER_BEGIN = "<!-- agentq:begin -->";
export const AGENTQ_MARKER_END = "<!-- agentq:end -->";

export type MarkerAction =
  | "create"
  | "update"
  | "unchanged"
  | "remove"
  | "delete"
  | "missing";

export interface MarkerTarget {
  readonly relativePath: string;
  readonly label: string;
  readonly preamble?: string;
  readonly markerBody: string;
  readonly deleteWhenAgentQOnly?: boolean;
}

export interface MarkerPlanEntry {
  readonly relativePath: string;
  readonly label: string;
  readonly action: MarkerAction;
  readonly markerBlock: string;
  readonly beforeExists: boolean;
}

export interface MarkerPlan {
  readonly workspaceRoot: string;
  readonly entries: readonly MarkerPlanEntry[];
  readonly hookCommands: readonly string[];
  readonly uninstallCommand: string;
  readonly commitGuidance: readonly string[];
}

export interface MarkerInstallOptions {
  readonly targets?: readonly MarkerTarget[];
}

interface MarkerEdit {
  readonly action: MarkerAction;
  readonly content: string;
}

const ROOT_MARKER_BODY = [
  "# AgentQ",
  "",
  "See `.github/instructions/agentq.instructions.md`.",
  "Primary: `agentq next --actor <id>` before finish or when ambiguous.",
  "Use hook id; let `next` show exact inbox/work/scope commands.",
  "`owners` routes, not locks; `question` for overlap, `note` for context.",
  "After `work start`, record context evidence: frame, basis, paths/resources, next check.",
  "Before done: run `next`, final evidence, then `done-check`.",
  "External failures: `block` with evidence."
].join("\n");

const SCOPED_MARKER_BODY = [
  "# AgentQ",
  "",
  "This workspace uses AgentQ: required-response queues for coding agents.",
  "",
  "- Use the hook actor id; every command must pass `--actor <id>`.",
  "- Primary command: `agentq next --actor <id>` before finish, after questions, and whenever AgentQ state is ambiguous.",
  "- Let `next` print exact inbox/work/scope commands instead of guessing the lower-level sequence.",
  "- Track work with `agentq work start --actor <id>`; immediately record context evidence after start: current frame, observed basis, touched paths/resources, next pass check.",
  "- Run `agentq next --actor <id>` and then `agentq done-check --actor <id>` before done.",
  "- Shared edit/tool: `agentq owners --path <path>` / `--resource <resource>`; owners route, not lock. Use `question` to classify overlap, `note` for context.",
  "- Required replies block done-check; answer with `agentq respond ... --status answered|resolved|blocked|not_mine|invalid`.",
  "- If build/test/generated failures are outside active work, create `agentq block` with path/contract and evidence before reporting done.",
  "- Broad `.` routing is ignored; use precise paths/contracts or `--to`.",
  "- Do not create repo `.agentq/` or `agentq.config.yaml`; runtime state is OS-local."
].join("\n");

export const DEFAULT_MARKER_TARGETS: readonly MarkerTarget[] = [
  {
    relativePath: "AGENTS.md",
    label: "shared Codex-compatible instruction marker",
    markerBody: ROOT_MARKER_BODY
  },
  {
    relativePath: "CLAUDE.md",
    label: "Claude Code instruction marker",
    markerBody: ROOT_MARKER_BODY
  },
  {
    relativePath: ".github/instructions/agentq.instructions.md",
    label: "GitHub Copilot instruction marker",
    preamble: "---\napplyTo: \"**\"\n---\n\n",
    markerBody: SCOPED_MARKER_BODY,
    deleteWhenAgentQOnly: true
  }
];

export async function planMarkerInstall(
  workspaceRoot: string,
  options: MarkerInstallOptions = {}
): Promise<MarkerPlan> {
  return await planMarkerMutation(workspaceRoot, "install", options.targets ?? DEFAULT_MARKER_TARGETS);
}

export async function applyMarkerInstall(
  workspaceRoot: string,
  options: MarkerInstallOptions = {}
): Promise<MarkerPlan> {
  const targets = options.targets ?? DEFAULT_MARKER_TARGETS;
  const plan = await planMarkerMutation(workspaceRoot, "install", targets);
  await applyMarkerPlan(workspaceRoot, plan.entries, targets);
  return plan;
}

export async function planMarkerUninstall(
  workspaceRoot: string,
  options: MarkerInstallOptions = {}
): Promise<MarkerPlan> {
  return await planMarkerMutation(workspaceRoot, "uninstall", options.targets ?? DEFAULT_MARKER_TARGETS);
}

export async function applyMarkerUninstall(
  workspaceRoot: string,
  options: MarkerInstallOptions = {}
): Promise<MarkerPlan> {
  const targets = options.targets ?? DEFAULT_MARKER_TARGETS;
  const plan = await planMarkerMutation(workspaceRoot, "uninstall", targets);
  await applyMarkerPlan(workspaceRoot, plan.entries, targets);
  return plan;
}

export function renderMarkerBlock(target: MarkerTarget): string {
  return `${AGENTQ_MARKER_BEGIN}\n${target.markerBody.trim()}\n${AGENTQ_MARKER_END}\n`;
}

export function upsertMarkerBlock(content: string, markerBlock: string): MarkerEdit {
  const existing = findSingleMarker(content);
  if (existing === undefined) {
    const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    return {
      action: "create",
      content: `${content}${separator}${ensureTrailingNewline(markerBlock)}`
    };
  }

  const replacement = ensureTrailingNewline(markerBlock);
  const nextContent = `${content.slice(0, existing.start)}${replacement}${content.slice(existing.end)}`;
  return {
    action: nextContent === content ? "unchanged" : "update",
    content: nextContent
  };
}

export function removeMarkerBlock(content: string): MarkerEdit {
  const existing = findSingleMarker(content);
  if (existing === undefined) {
    return {
      action: "missing",
      content
    };
  }

  return {
    action: "remove",
    content: `${content.slice(0, existing.start)}${content.slice(existing.end)}`
  };
}

async function planMarkerMutation(
  workspaceRoot: string,
  mode: "install" | "uninstall",
  targets: readonly MarkerTarget[]
): Promise<MarkerPlan> {
  const entries: MarkerPlanEntry[] = [];

  for (const target of targets) {
    const absolutePath = path.join(workspaceRoot, target.relativePath);
    const before = await readOptionalFile(absolutePath);
    const markerBlock = renderMarkerBlock(target);
    const preamble = target.preamble ?? "";
    const seedContent = before ?? preamble;
    const edit =
      mode === "install"
        ? upsertMarkerBlock(seedContent, markerBlock)
        : removeMarkerBlock(seedContent);
    const action =
      mode === "uninstall" && edit.action === "remove" && shouldDeleteAfterUninstall(target, edit.content)
        ? "delete"
        : edit.action;

    entries.push({
      relativePath: target.relativePath,
      label: target.label,
      action,
      markerBlock,
      beforeExists: before !== undefined
    });
  }

  return {
    workspaceRoot,
    entries,
    hookCommands: [
      "agentq hook codex session-start",
      "agentq hook codex pre-tool",
      "agentq hook codex stop",
      "agentq hook claude-code session-start",
      "agentq hook claude-code pre-tool",
      "agentq hook claude-code stop",
      "agentq hook copilot-cli session-start",
      "agentq hook copilot-cli pre-tool",
      "agentq hook copilot-cli stop"
    ],
    uninstallCommand: "agentq uninstall --yes",
    commitGuidance: [
      "Review instruction marker diffs before committing.",
      "Commit only project instruction files that your team wants shared.",
      "Never commit OS-local AgentQ runtime state."
    ]
  };
}

async function applyMarkerPlan(
  workspaceRoot: string,
  entries: readonly MarkerPlanEntry[],
  targets: readonly MarkerTarget[]
): Promise<void> {
  const targetByPath = new Map(targets.map((target) => [target.relativePath, target]));

  for (const entry of entries) {
    if (entry.action === "unchanged" || entry.action === "missing") {
      continue;
    }

    const target = targetByPath.get(entry.relativePath);
    if (target === undefined) {
      throw new Error(`No marker target registered for ${entry.relativePath}`);
    }

    const absolutePath = path.join(workspaceRoot, entry.relativePath);
    if (entry.action === "delete") {
      await rm(absolutePath);
      continue;
    }

    const before = await readOptionalFile(absolutePath);
    const seedContent = before ?? target.preamble ?? "";
    const edit =
      entry.action === "remove"
        ? removeMarkerBlock(seedContent)
        : upsertMarkerBlock(seedContent, entry.markerBlock);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, edit.content, "utf8");
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function findSingleMarker(content: string): { readonly start: number; readonly end: number } | undefined {
  const beginCount = countOccurrences(content, AGENTQ_MARKER_BEGIN);
  const endCount = countOccurrences(content, AGENTQ_MARKER_END);

  if (beginCount !== endCount) {
    throw new Error("AgentQ marker conflict: begin/end marker count mismatch.");
  }

  if (beginCount > 1) {
    throw new Error("AgentQ marker conflict: multiple marker blocks found.");
  }

  if (beginCount === 0) {
    return undefined;
  }

  const start = content.indexOf(AGENTQ_MARKER_BEGIN);
  const markerEnd = content.indexOf(AGENTQ_MARKER_END);
  return {
    start,
    end: markerEnd + AGENTQ_MARKER_END.length + trailingNewlineLength(content, markerEnd + AGENTQ_MARKER_END.length)
  };
}

function shouldDeleteAfterUninstall(target: MarkerTarget, contentAfterMarkerRemoval: string): boolean {
  if (target.deleteWhenAgentQOnly !== true) {
    return false;
  }

  const preamble = target.preamble ?? "";
  return contentAfterMarkerRemoval.trim().length === 0 || contentAfterMarkerRemoval.trim() === preamble.trim();
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }

  return count;
}

function trailingNewlineLength(content: string, index: number): number {
  if (content.slice(index, index + 2) === "\r\n") {
    return 2;
  }

  return content[index] === "\n" ? 1 : 0;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
