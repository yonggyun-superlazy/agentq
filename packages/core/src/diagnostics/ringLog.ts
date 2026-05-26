import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { writeAtomicText } from "../store/writeOnce.js";

export const DiagnosticEventSchema = z
  .object({
    at: z.string().min(1),
    kind: z.enum(["hook"]),
    actorId: z.string().min(1).optional(),
    adapter: z.string().min(1).optional(),
    event: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    toolMode: z.enum(["read-only", "mutating", "stop"]).optional(),
    paths: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    ignoredCommands: z.array(z.string()).optional(),
    nudge: z.boolean().optional(),
    nudgeKinds: z.array(z.string().min(1)).optional(),
    decision: z.enum(["allow", "block", "context"]).optional(),
    note: z.string().min(1).optional()
  })
  .strict();

export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const DEFAULT_DIAGNOSTIC_RING_LIMIT = 10_000;

export async function appendDiagnosticEvent(
  store: WorkspaceStore,
  event: DiagnosticEvent,
  limit = DEFAULT_DIAGNOSTIC_RING_LIMIT
): Promise<void> {
  DiagnosticEventSchema.parse(event);
  const existingLines = await readRingLines(store);
  const nextLines = [...existingLines, JSON.stringify(event)].slice(-limit);
  await writeAtomicText(store.layout.diagnosticsRingPath, `${nextLines.join("\n")}\n`);
}

export async function tryAppendDiagnosticEvent(
  store: WorkspaceStore,
  event: DiagnosticEvent,
  limit = DEFAULT_DIAGNOSTIC_RING_LIMIT
): Promise<void> {
  try {
    await appendDiagnosticEvent(store, event, limit);
  } catch {
    // Diagnostics must never break hook gating.
  }
}

export async function readDiagnosticEvents(
  store: WorkspaceStore,
  limit = 40
): Promise<DiagnosticEvent[]> {
  const lines = await readRingLines(store);
  return lines
    .slice(-limit)
    .map((line) => DiagnosticEventSchema.parse(JSON.parse(line)) as DiagnosticEvent);
}

async function readRingLines(store: WorkspaceStore): Promise<string[]> {
  try {
    return (await readFile(store.layout.diagnosticsRingPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
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
