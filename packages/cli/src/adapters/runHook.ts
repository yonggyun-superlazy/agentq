import {
  ensureWorkspaceStore,
  findOwners,
  listInbox,
  registerAdapterSession,
  resolveAdapterSessionActorId,
  resolveWorkspaceStore,
  type RegistrationUnavailableReason
} from "@agentq/core";
import path from "node:path";

export const OVERLAP_CONTEXT =
  "Another active session has a declared claim overlapping this file.";
export const PENDING_QUESTION_CONTEXT_PREFIX =
  "A required coordination question is pending for this session: ";

export interface ClientHookDiagnostic {
  readonly code:
    | "registration_unavailable"
    | "session_unregistered"
    | "invalid_payload"
    | "hook_lookup_failed";
  readonly reason?: RegistrationUnavailableReason;
  readonly detail?: string;
}

export interface ClientHookResult {
  readonly code: 0;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly ClientHookDiagnostic[];
}

export interface HookAdapterOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
}

export async function runSessionStart(
  adapterId: "codex" | "claude",
  nativeSessionId: string | undefined,
  cwd: string | undefined,
  options: HookAdapterOptions = {}
): Promise<ClientHookResult> {
  if (nativeSessionId === undefined || nativeSessionId.trim().length === 0) {
    return quiet([{ code: "registration_unavailable", reason: "missing_native_session" }]);
  }
  if (cwd === undefined || cwd.trim().length === 0) {
    return quiet([{ code: "invalid_payload", detail: "missing cwd" }]);
  }

  try {
    const store = await resolveWorkspaceStore(cwd, { env: options.env ?? process.env });
    await ensureWorkspaceStore(store);
    const result = await registerAdapterSession(store, {
      adapterId,
      nativeSessionId,
      cwd,
      now: (options.now ?? (() => new Date().toISOString()))()
    });
    if (result.status === "unavailable") {
      return quiet([
        {
          code: "registration_unavailable",
          reason: result.reason,
          ...(result.diagnostic === undefined ? {} : { detail: result.diagnostic })
        }
      ]);
    }
    return quiet();
  } catch (error) {
    return quiet([
      {
        code: "registration_unavailable",
        reason: "store_error",
        detail: errorText(error)
      }
    ]);
  }
}

export async function runStructuredEditLookup(
  adapterId: "codex" | "claude",
  nativeSessionId: string | undefined,
  cwd: string | undefined,
  targets: readonly string[],
  options: HookAdapterOptions = {}
): Promise<ClientHookResult> {
  if (targets.length === 0) {
    return quiet();
  }
  if (
    nativeSessionId === undefined ||
    nativeSessionId.trim().length === 0 ||
    cwd === undefined ||
    cwd.trim().length === 0
  ) {
    return quiet([{ code: "session_unregistered" }]);
  }

  try {
    const store = await resolveWorkspaceStore(cwd, { env: options.env ?? process.env });
    const actorId = await resolveAdapterSessionActorId(store, {
      adapterId,
      nativeSessionId,
      cwd
    });

    let hasOverlap = false;
    for (const target of targets) {
      // TODO(post-0.2 collision gate): replace this read-only lookup with atomic
      // conflicting-claim acquisition, renewable leases, and named runtime-resource
      // authorization before enabling mutation blocking or shell coverage.
      const owners = await findOwners(store, actorId, {
        paths: [rebaseWorkspaceAliasTarget(cwd, store.workspaceRoot, target)],
        resources: [],
        contracts: []
      });
      hasOverlap ||= owners.length > 0;
    }

    const pending = await listInbox(store, actorId);
    const firstPending = pending[0];
    if (firstPending !== undefined) {
      return context(
        "PreToolUse",
        `${PENDING_QUESTION_CONTEXT_PREFIX}${firstPending.question}`
      );
    }
    return hasOverlap ? context("PreToolUse", OVERLAP_CONTEXT) : quiet();
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return quiet([{ code: "session_unregistered" }]);
    }
    return quiet([{ code: "hook_lookup_failed", detail: errorText(error) }]);
  }
}

function rebaseWorkspaceAliasTarget(
  sessionCwd: string,
  canonicalWorkspaceRoot: string,
  target: string
): string {
  if (!path.isAbsolute(target)) {
    return target;
  }

  const relative = path.relative(path.resolve(sessionCwd), path.resolve(target));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return target;
  }
  return path.join(canonicalWorkspaceRoot, relative);
}

export function quiet(
  diagnostics: readonly ClientHookDiagnostic[] = []
): ClientHookResult {
  return { code: 0, stdout: "", stderr: "", diagnostics };
}

function context(
  hookEventName: "SessionStart" | "PreToolUse",
  additionalContext: string
): ClientHookResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext }
    }),
    stderr: "",
    diagnostics: []
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
