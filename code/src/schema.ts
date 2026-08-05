import { z } from "zod";

export const routingDecisionSchema = z
  .object({
    action: z.enum(["notify", "digest", "mute"]),
    message_type: z.enum([
      "personal",
      "urgent",
      "event",
      "payment",
      "business_update",
      "promotion",
      "greeting",
      "forward",
      "spam",
      "scam",
      "unknown",
    ]),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
    evidence_message_ids: z
      .string()
      .regex(
        /^(?:none|[^;\s]+(?:;[^;\s]+)*)$/,
        'Must be "none" or a semicolon-separated list of message IDs',
      ),
  })
  .strict();

export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

export const batchRoutingDecisionSchema = z
  .object({
    decisions: z
      .array(
        routingDecisionSchema.extend({
          message_id: z.string().min(1),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type BatchRoutingDecision = z.infer<typeof batchRoutingDecisionSchema>;
