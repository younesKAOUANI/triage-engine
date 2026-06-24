import { TicketEntity } from '../tickets/entities/ticket.entity';
import { TicketCategory, TicketPriority } from '../tickets/ticket.enums';

const CATEGORIES = Object.values(TicketCategory).join(', ');
const PRIORITIES = Object.values(TicketPriority).join(', ');

/**
 * System prompt. JSON mode requires us to also instruct the model to emit JSON
 * (per Mistral's docs), and we pin the exact enum vocabulary so the output lines
 * up with our validation schema and our domain enums.
 */
export const ENRICHMENT_SYSTEM_PROMPT = `You are a support-ticket triage assistant.
Classify the ticket and respond with a SINGLE JSON object and nothing else.

The JSON object must have exactly these keys:
- "category": one of [${CATEGORIES}]
- "priority": one of [${PRIORITIES}]
- "summary": a one-line summary, at most 280 characters
- "confidence": a number between 0 and 1 reflecting your confidence

Use uppercase enum values exactly as listed. Do not add commentary or markdown.`;

/** Keep the user message compact and deterministic. */
export function buildUserPrompt(ticket: TicketEntity): string {
  return JSON.stringify({
    subject: ticket.subject,
    body: ticket.body,
  });
}
