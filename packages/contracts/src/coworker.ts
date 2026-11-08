import { z } from "zod";

/**
 * AI coworker conversation (Phase 4).
 *
 * SECURITY BOUNDARY: everything here is shown to the assigned employee. A coworker
 * turn is ADVISORY TEXT written by a language model. It is never evidence, never a
 * test result, never an approval. Nothing in these schemas carries hidden suite
 * content, prompts, token usage, provider request ids or other people's data.
 */

export const COWORKER_MAX_MESSAGE_CHARS = 600;
export const COWORKER_MAX_REPLY_CHARS = 2000;
/** Successful (COMPLETE) turns allowed per session. */
export const COWORKER_MAX_COMPLETED_TURNS = 20;
/** All reserved turns per session, errors included (bounds paid calls even when they fail). */
export const COWORKER_MAX_ATTEMPTS = 30;

export const TurnIdSchema = z.string().regex(/^turn_\d{13}_[0-9a-f]{12}$/);

/** STRICT: only the message. No role, model, prompt, session status or credentials can be supplied. */
export const CoworkerMessageRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(COWORKER_MAX_MESSAGE_CHARS),
});
export type CoworkerMessageRequest = z.infer<typeof CoworkerMessageRequestSchema>;

export const CoworkerTurnStatusSchema = z.enum(["PENDING", "COMPLETE", "ERROR"]);
export type CoworkerTurnStatus = z.infer<typeof CoworkerTurnStatusSchema>;

export const CoworkerTurnViewSchema = z.object({
  turnId: TurnIdSchema,
  status: CoworkerTurnStatusSchema,
  userText: z.string(),
  /** AI-generated text, or null while PENDING / after an ERROR. Render as plain text. */
  reply: z.string().max(COWORKER_MAX_REPLY_CHARS).nullable(),
  /** The model stopped at its output limit, so the reply may end mid-thought. */
  truncated: z.boolean(),
  /** The model that wrote the reply (or was asked to). */
  modelId: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type CoworkerTurnView = z.infer<typeof CoworkerTurnViewSchema>;

export const CoworkerStateSchema = z.object({
  /** false when the deployment has no model configured: the panel must say AI is unavailable. */
  enabled: z.boolean(),
  /** Whether a new message would be accepted right now. */
  canSend: z.boolean(),
  /** Why not, in words, when canSend is false. */
  reason: z.string().nullable(),
  modelId: z.string().nullable(),
  completedTurns: z.number().int().nonnegative(),
  attemptsUsed: z.number().int().nonnegative(),
  limits: z.object({
    maxMessageChars: z.number().int().positive(),
    maxCompletedTurns: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
  }),
});
export type CoworkerState = z.infer<typeof CoworkerStateSchema>;

export const ListCoworkerMessagesResponseSchema = z.object({
  turns: z.array(CoworkerTurnViewSchema),
  coworker: CoworkerStateSchema,
});
export type ListCoworkerMessagesResponse = z.infer<typeof ListCoworkerMessagesResponseSchema>;

export const PostCoworkerMessageResponseSchema = z.object({
  turn: CoworkerTurnViewSchema,
  coworker: CoworkerStateSchema,
  /** false when an identical retry (same Idempotency-Key and text) returned the original turn. */
  created: z.boolean(),
});
export type PostCoworkerMessageResponse = z.infer<typeof PostCoworkerMessageResponseSchema>;
