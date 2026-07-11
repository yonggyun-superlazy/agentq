import type { z } from "zod";
import {
  AdapterIdSchema,
  PresenceSchema,
  QuestionRecordSchema,
  QuestionStatusSchema
} from "./schema.js";

export type AdapterId = z.infer<typeof AdapterIdSchema>;
export interface ClaimSnapshot {
  readonly paths: readonly string[];
  readonly resources: readonly string[];
  readonly contracts: readonly string[];
}
export type Presence = z.infer<typeof PresenceSchema>;
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export type QuestionRecord = z.infer<typeof QuestionRecordSchema>;

export type WorkspaceHash = string;
export type ActorId = string;
