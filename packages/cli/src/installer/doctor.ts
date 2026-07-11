import path from "node:path";
import {
  adapterConfigPath,
  hasExpectedEntries,
  inspectCodexFeatureSource,
  readJsonConfig,
  readOptional,
  type FirstPartyAdapter
} from "./hookConfig.js";

export interface DoctorDiagnostic {
  readonly code: string;
  readonly status: "ok" | "warning" | "error";
  readonly path?: string;
  readonly detail?: string;
}

export async function inspectProjectHooks(
  workspaceRoot: string,
  handlerCommand: string
): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  diagnostics.push(...(await inspectAdapter(workspaceRoot, "codex", handlerCommand)));
  diagnostics.push(...(await inspectAdapter(workspaceRoot, "claude", handlerCommand)));
  diagnostics.push(
    {
      code: "codex_project_trust_unverified",
      status: "warning",
      detail: "project trust requires confirmation by the active Codex client"
    },
    {
      code: "codex_handler_trust_unverified",
      status: "warning",
      detail: "handler enabled and trusted-hash state requires confirmation by the active Codex client"
    }
  );
  return diagnostics;
}

async function inspectAdapter(
  workspaceRoot: string,
  adapter: FirstPartyAdapter,
  handlerCommand: string
): Promise<DoctorDiagnostic[]> {
  const filePath = adapterConfigPath(workspaceRoot, adapter);
  const diagnostics: DoctorDiagnostic[] = [];
  try {
    const root = await readJsonConfig(filePath);
    diagnostics.push(
      root === null
        ? { code: `${adapter}_hooks_missing`, status: "warning", path: filePath }
        : hasExpectedEntries(root, adapter, handlerCommand)
          ? { code: `${adapter}_hooks_ok`, status: "ok", path: filePath }
          : { code: `${adapter}_hooks_mismatch`, status: "error", path: filePath }
    );
  } catch (error) {
    diagnostics.push({
      code: `${adapter}_hooks_invalid`,
      status: "error",
      path: filePath,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  if (adapter === "codex") {
    const featurePath = path.join(workspaceRoot, ".codex", "config.toml");
    let state: ReturnType<typeof inspectCodexFeatureSource> = "invalid";
    try {
      state = inspectCodexFeatureSource(await readOptional(featurePath));
    } catch {
      state = "invalid";
    }
    diagnostics.push({
      code:
        state === "enabled"
          ? "codex_feature_enabled"
          : state === "missing"
            ? "codex_feature_missing"
            : state === "disabled"
              ? "codex_feature_disabled"
              : "codex_feature_invalid",
      status: state === "enabled" ? "ok" : state === "invalid" ? "error" : "warning",
      path: featurePath
    });
  }
  return diagnostics;
}
