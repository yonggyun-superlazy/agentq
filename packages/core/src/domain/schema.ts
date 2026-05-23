import { parse, stringify } from "yaml";
import { z } from "zod";

export const SafeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.@-]+$/, "identifier may contain only letters, digits, _, ., @, and -")
  .refine((value) => value !== "." && value !== "..", "identifier may not be . or ..");
const NonEmptyStringSchema = z.string().min(1);
const NonEmptyStringArraySchema = z.array(NonEmptyStringSchema);

export const AgentKindSchema = z.enum(["codex", "claude-code", "copilot-cli", "custom"]);

export const ResponseStatusSchema = z.enum([
  "resolved",
  "answered",
  "not_mine",
  "invalid",
  "blocked"
]);

export const PresenceSchema = z
  .object({
    actorId: SafeIdSchema,
    kind: AgentKindSchema,
    handle: NonEmptyStringSchema,
    workspaceRoot: NonEmptyStringSchema,
    activePaths: NonEmptyStringArraySchema,
    observedPaths: NonEmptyStringArraySchema.optional(),
    activeResources: NonEmptyStringArraySchema.optional(),
    responsibilities: NonEmptyStringArraySchema,
    summary: NonEmptyStringSchema,
    lastSeen: NonEmptyStringSchema
  })
  .strict();

const BaseMessageSchema = z
  .object({
    id: SafeIdSchema,
    createdBy: SafeIdSchema,
    summary: NonEmptyStringSchema,
    paths: NonEmptyStringArraySchema,
    resources: NonEmptyStringArraySchema.optional(),
    contracts: NonEmptyStringArraySchema,
    passCriteria: NonEmptyStringArraySchema
  })
  .strict();

function requireRoutingSurface(
  value: { paths: readonly string[]; resources?: readonly string[] | undefined; contracts: readonly string[] },
  ctx: z.RefinementCtx
): void {
  if (value.paths.length === 0 && (value.resources ?? []).length === 0 && value.contracts.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "message requires at least one path, resource, or contract"
    });
  }
}

export const BlockerMessageSchema = BaseMessageSchema.extend({
  kind: z.literal("blocker"),
  observed: NonEmptyStringSchema,
  brokenContract: NonEmptyStringSchema
})
  .strict()
  .superRefine(requireRoutingSurface);

export const QuestionMessageSchema = BaseMessageSchema.extend({
  kind: z.literal("question"),
  question: NonEmptyStringSchema,
  expectedAnswer: NonEmptyStringSchema.optional()
})
  .strict()
  .superRefine((value, ctx) => {
    requireRoutingSurface(value, ctx);

    if (value.passCriteria.length === 0 && value.expectedAnswer === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "question requires passCriteria or expectedAnswer"
      });
    }
  });

export const NoteMessageSchema = BaseMessageSchema.extend({
  kind: z.literal("note"),
  body: NonEmptyStringSchema
})
  .strict()
  .superRefine(requireRoutingSurface);

export const MessageSchema = z.discriminatedUnion("kind", [
  BlockerMessageSchema,
  QuestionMessageSchema,
  NoteMessageSchema
]);

export const RoutingEvidenceSchema = z
  .object({
    kind: z.enum(["explicit", "contract", "path", "resource", "thread", "recent"]),
    detail: NonEmptyStringSchema
  })
  .strict();

export const RequiredRequestSchema = z
  .object({
    messageId: SafeIdSchema,
    to: SafeIdSchema,
    required: z.boolean(),
    routingEvidence: z.array(RoutingEvidenceSchema).min(1)
  })
  .strict();

export const ResponseEventSchema = z
  .object({
    kind: z.literal("response"),
    id: SafeIdSchema,
    messageId: SafeIdSchema,
    actorId: SafeIdSchema,
    status: ResponseStatusSchema,
    evidence: NonEmptyStringArraySchema.min(1),
    at: NonEmptyStringSchema
  })
  .strict();

export const FollowUpEventSchema = z
  .object({
    kind: z.literal("follow_up"),
    id: SafeIdSchema,
    messageId: SafeIdSchema,
    actorId: SafeIdSchema,
    blockedActorId: SafeIdSchema,
    evidence: NonEmptyStringArraySchema.min(1),
    at: NonEmptyStringSchema
  })
  .strict();

export const AcceptBlockedEventSchema = z
  .object({
    kind: z.literal("accept_blocked"),
    id: SafeIdSchema,
    messageId: SafeIdSchema,
    actorId: SafeIdSchema,
    blockedActorId: SafeIdSchema,
    evidence: NonEmptyStringArraySchema.min(1),
    at: NonEmptyStringSchema
  })
  .strict();

export const SupersedeEventSchema = z
  .object({
    kind: z.literal("supersede"),
    id: SafeIdSchema,
    messageId: SafeIdSchema,
    actorId: SafeIdSchema,
    targetActorId: SafeIdSchema,
    evidence: NonEmptyStringArraySchema.min(1),
    at: NonEmptyStringSchema
  })
  .strict();

export const DeliveryAttemptStatusSchema = z.enum([
  "executed",
  "failed",
  "timed_out",
  "no_binding",
  "record_only"
]);

export const DeliveryAttemptEventSchema = z
  .object({
    kind: z.literal("delivery_attempt"),
    id: SafeIdSchema,
    messageId: SafeIdSchema,
    actorId: SafeIdSchema,
    status: DeliveryAttemptStatusSchema,
    adapter: AgentKindSchema.optional(),
    sessionId: NonEmptyStringSchema.optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    evidence: NonEmptyStringArraySchema.min(1),
    at: NonEmptyStringSchema
  })
  .strict();

export const EventSchema = z.discriminatedUnion("kind", [
  ResponseEventSchema,
  FollowUpEventSchema,
  AcceptBlockedEventSchema,
  SupersedeEventSchema,
  DeliveryAttemptEventSchema
]);

export function parseYamlWithSchema<T>(schema: z.ZodType<T>, source: string): T {
  return schema.parse(parse(source));
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}
