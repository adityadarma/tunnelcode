import { z } from 'zod';

/**
 * Body the browser posts to create a conversation.
 *
 * Both fields are optional: omitting the engine takes the one the terminal named,
 * and omitting the model lets the engine decide. The engine is only accepted here,
 * never on an update, because it is fixed for the life of the conversation.
 * See ADR-020.
 */
export const createConversationSchema = z.object({
  engine: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

/**
 * Body the browser patches a conversation with.
 *
 * Only the model. Null is accepted and read as absent, because "let the engine
 * decide" is a real choice rather than a missing field.
 */
export const updateConversationSchema = z.object({
  model: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? undefined),
});

export type CreateConversationRequest = z.infer<typeof createConversationSchema>;
export type UpdateConversationRequest = z.infer<typeof updateConversationSchema>;
