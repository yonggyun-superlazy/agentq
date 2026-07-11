import { parse, stringify } from "yaml";
import { z } from "zod";

export const SafeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.@-]+$/, "identifier may contain only letters, digits, _, ., @, and -")
  .refine((value) => value !== "." && value !== "..", "identifier may not be . or ..");

export const AdapterIdSchema = z
  .string()
  .min(1, "adapter id is required")
  .max(64, "adapter id must be at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "adapter id may contain only lowercase letters, digits, ., _, and -"
  );

export const ClaimSnapshotSchema = z
  .object({
    paths: z.array(z.string()),
    resources: z.array(z.string()),
    contracts: z.array(z.string())
  })
  .strict();

export const PresenceSchema = z
  .object({
    actorId: SafeIdSchema,
    adapterId: AdapterIdSchema,
    workspaceRoot: z.string().min(1),
    lastSeen: z.string().min(1)
  })
  .strict();

export const QuestionStatusSchema = z.enum([
  "pending",
  "answered",
  "not_mine",
  "cancelled"
]);

export const QuestionRecordSchema = z
  .object({
    id: SafeIdSchema,
    senderActorId: SafeIdSchema,
    recipientActorId: SafeIdSchema,
    question: z.string().trim().min(1),
    scope: ClaimSnapshotSchema,
    status: QuestionStatusSchema,
    answer: z.string().trim().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.senderActorId === value.recipientActorId) {
      ctx.addIssue({ code: "custom", message: "question sender and recipient must differ" });
    }
    if (
      value.scope.paths.length === 0 &&
      value.scope.resources.length === 0 &&
      value.scope.contracts.length === 0
    ) {
      ctx.addIssue({ code: "custom", message: "question requires declared scope" });
    }
    if (value.status === "answered" && value.answer === undefined) {
      ctx.addIssue({ code: "custom", message: "answered question requires an answer" });
    }
    if (value.status !== "answered" && value.answer !== undefined) {
      ctx.addIssue({ code: "custom", message: "only answered questions may store an answer" });
    }
  });

export function parseYamlWithSchema<T>(schema: z.ZodType<T>, source: string): T {
  return schema.parse(parse(source));
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}
