import { AdapterIdSchema } from "../domain/schema.js";
import type { AdapterId } from "../domain/types.js";

export type { AdapterId };

export type RegistrationUnavailableReason =
  | "missing_native_session"
  | "workspace_mismatch"
  | "store_error";

export type RegistrationResult =
  | { readonly status: "registered"; readonly actorId: string }
  | {
      readonly status: "unavailable";
      readonly reason: RegistrationUnavailableReason;
      readonly diagnostic?: string;
    };

export function normalizeAdapterId(value: string): AdapterId {
  return AdapterIdSchema.parse(value.trim().toLowerCase());
}
