import { z } from 'zod';
import {
  TicketCategory,
  TicketPriority,
} from '../tickets/ticket.enums';

/**
 * The exact shape we require back from the model. We never trust the model's
 * output blindly — JSON mode guarantees *valid JSON*, not *correct content*, so
 * every response is validated against this schema. A failure here is raised as a
 * TransientEnrichmentError (see errors.ts / ADR-0005).
 *
 * Enums are upper-cased before validation so trivial casing differences don't
 * cause a needless retry, but the *set* of allowed values is still strict — an
 * unknown category fails validation rather than being silently coerced.
 */
const upperEnum = <T extends Record<string, string>>(e: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.toUpperCase().trim() : v),
    z.nativeEnum(e),
  );

export const llmEnrichmentSchema = z.object({
  category: upperEnum(TicketCategory),
  priority: upperEnum(TicketPriority),
  summary: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string().min(1).max(280),
  ),
  confidence: z.number().min(0).max(1),
});

export type LlmEnrichment = z.infer<typeof llmEnrichmentSchema>;
