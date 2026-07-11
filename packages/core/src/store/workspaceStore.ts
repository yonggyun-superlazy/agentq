import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseYamlWithSchema } from "../domain/schema.js";
import { createWorkspaceStoreLayout, type WorkspaceStoreLayout } from "./layout.js";
import { isFileAlreadyExistsError, writeOnceYaml } from "./writeOnce.js";

export const AGENTQ_PROTOCOL_VERSION = 1;

const MetadataSchema = z
  .object({
    protocolVersion: z.literal(AGENTQ_PROTOCOL_VERSION),
    workspaceRoot: z.string().min(1),
    workspaceHash: z.string().min(1)
  })
  .strict();

export interface WorkspaceStore {
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  readonly platform: NodeJS.Platform;
  readonly layout: WorkspaceStoreLayout;
}

export interface WorkspaceStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export async function resolveWorkspaceStore(
  workspaceRoot: string,
  options: WorkspaceStoreOptions = {}
): Promise<WorkspaceStore> {
  const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
  const workspaceHash = hashWorkspaceRoot(canonicalRoot);
  const platform = options.platform ?? process.platform;
  const stateRoot = resolveStateRoot(platform, options.env ?? process.env);
  const layout = createWorkspaceStoreLayout(path.join(stateRoot, "agentq", "workspaces", workspaceHash));
  return { workspaceRoot: canonicalRoot, workspaceHash, platform, layout };
}

export async function ensureWorkspaceStore(store: WorkspaceStore): Promise<void> {
  await mkdir(store.layout.root, { recursive: true });
  await mkdir(store.layout.actorsDir, { recursive: true });
  await mkdir(store.layout.sessionsDir, { recursive: true });
  await mkdir(store.layout.inboxDir, { recursive: true });
  await mkdir(store.layout.questionsDir, { recursive: true });

  const metadata = {
    protocolVersion: AGENTQ_PROTOCOL_VERSION,
    workspaceRoot: store.workspaceRoot,
    workspaceHash: store.workspaceHash
  };
  try {
    await writeOnceYaml(store.layout.metadataPath, metadata);
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
    const existing = parseYamlWithSchema(MetadataSchema, await readFile(store.layout.metadataPath, "utf8"));
    if (existing.workspaceRoot !== metadata.workspaceRoot || existing.workspaceHash !== metadata.workspaceHash) {
      throw new Error(`AgentQ metadata mismatch at ${store.layout.metadataPath}`);
    }
  }
}

async function canonicalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
  return path.normalize(await realpath(path.resolve(workspaceRoot)));
}

function hashWorkspaceRoot(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function resolveStateRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.length === 0) {
      throw new Error("AgentQ requires LOCALAPPDATA to resolve the Windows workspace store.");
    }
    return localAppData;
  }
  if (platform === "darwin") {
    return path.join(env.HOME ?? os.homedir(), "Library", "Application Support");
  }
  return env.XDG_STATE_HOME ?? path.join(env.HOME ?? os.homedir(), ".local", "state");
}
