import { z } from "zod";
import { SafeIdSchema } from "../domain/schema.js";

const NonEmptyStringSchema = z.string().min(1);
const NonEmptyStringArraySchema = z.array(NonEmptyStringSchema).min(1);
export const WorkTerminalStatusSchema = z.enum(["closed", "abandoned", "superseded"]);

const BaseWorkEventSchema = z
  .object({
    id: SafeIdSchema,
    workId: SafeIdSchema,
    actorId: SafeIdSchema,
    at: NonEmptyStringSchema
  })
  .strict();

export const WorkStartedEventSchema = BaseWorkEventSchema.extend({
  kind: z.literal("work_started"),
  parentWorkId: SafeIdSchema.nullable(),
  title: NonEmptyStringSchema,
  goal: NonEmptyStringSchema,
  paths: NonEmptyStringArraySchema
}).strict();

export const WorkTouchedEventSchema = BaseWorkEventSchema.extend({
  kind: z.literal("work_touched"),
  paths: NonEmptyStringArraySchema
}).strict();

export const WorkEvidenceEventSchema = BaseWorkEventSchema.extend({
  kind: z.literal("work_evidence"),
  evidence: NonEmptyStringArraySchema
}).strict();

export const WorkClosedEventSchema = BaseWorkEventSchema.extend({
  kind: z.literal("work_closed"),
  status: WorkTerminalStatusSchema.optional(),
  summary: NonEmptyStringSchema,
  evidence: z.array(NonEmptyStringSchema)
}).strict();

export const WorkEventSchema = z.discriminatedUnion("kind", [
  WorkStartedEventSchema,
  WorkTouchedEventSchema,
  WorkEvidenceEventSchema,
  WorkClosedEventSchema
]);

export const ActorWorkPointerSchema = z
  .object({
    actorId: SafeIdSchema,
    activeWorkId: SafeIdSchema.nullable(),
    updatedAt: NonEmptyStringSchema
  })
  .strict();

export type WorkEvent = z.infer<typeof WorkEventSchema>;
export type ActorWorkPointer = z.infer<typeof ActorWorkPointerSchema>;
