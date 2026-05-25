import type { Presence } from "../domain/types.js";

export function isBookkeepingPresence(presence: Presence): boolean {
  if ((presence.activeResources ?? []).length > 0) {
    return false;
  }

  return presence.responsibilities.every(isBookkeepingResponsibility);
}

export function isBroadPresencePath(pathValue: string): boolean {
  return normalizePresencePath(pathValue) === ".";
}

export function isGenericResponsibility(responsibility: string): boolean {
  return /(^| )(active tool scope|pre-tool scope|read scope|stop gate|session)( |$)/i.test(responsibility) ||
    /^(codex|claude-code|copilot-cli|custom) actor$/i.test(responsibility.trim());
}

function isBookkeepingResponsibility(responsibility: string): boolean {
  return isGenericResponsibility(responsibility) ||
    /^(probe|quick[- ]path[- ]check)$/i.test(responsibility.trim());
}

function normalizePresencePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}
