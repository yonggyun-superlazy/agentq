import type { z } from "zod";
import {
  AgentKindSchema,
  DeliveryAttemptStatusSchema,
  EventSchema,
  MessageSchema,
  PresenceSchema,
  RequiredRequestSchema,
  ResponseStatusSchema
} from "./schema.js";

export type AgentKind = z.infer<typeof AgentKindSchema>;
export type Presence = z.infer<typeof PresenceSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type RequiredRequest = z.infer<typeof RequiredRequestSchema>;
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;
export type DeliveryAttemptStatus = z.infer<typeof DeliveryAttemptStatusSchema>;
export type AgentQEvent = z.infer<typeof EventSchema>;

export type WorkspaceHash = string;
export type ActorId = string;
export type MessageId = string;
export type EventId = string;
