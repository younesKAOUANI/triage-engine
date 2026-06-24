import { Injectable } from '@nestjs/common';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import {
  TicketCategory,
  TicketPriority,
} from '../tickets/ticket.enums';
import { LlmEnrichment } from './llm-response.schema';

/**
 * Rule-based classifier used when the AI is unavailable (ADR-0006). It is
 * deterministic, dependency-free, and instant, and crucially it returns the
 * SAME shape as the AI path (LlmEnrichment) so a degraded result is a true
 * drop-in. It is intentionally simple keyword matching — its job is to keep
 * tickets usable during an outage, not to rival the model. The low confidence it
 * reports signals "this is a degraded classification".
 */
@Injectable()
export class FallbackClassifier {
  private static readonly CATEGORY_KEYWORDS: Array<
    [TicketCategory, string[]]
  > = [
    [TicketCategory.BILLING, ['charge', 'invoice', 'refund', 'payment', 'billed', 'subscription', 'price']],
    [TicketCategory.ACCOUNT, ['password', 'login', 'log in', 'locked', 'access', 'sign in', 'account', '2fa', 'reset']],
    [TicketCategory.TECHNICAL, ['crash', 'error', 'bug', 'broken', '500', 'fails', 'not working', "doesn't work", 'freeze', 'exception']],
    [TicketCategory.FEATURE_REQUEST, ['feature', 'request', 'would be nice', 'please add', 'suggestion', 'wish']],
    [TicketCategory.COMPLAINT, ['terrible', 'worst', 'angry', 'unacceptable', 'disappointed', 'awful', 'frustrated']],
  ];

  private static readonly URGENT = ['urgent', 'asap', 'immediately', 'critical', 'down', 'outage', 'emergency'];
  private static readonly HIGH = ['crash', 'cannot', "can't", 'blocked', 'broken', 'data loss', 'security'];
  private static readonly LOW = ['question', 'how do i', 'how to', 'wondering', 'clarify'];

  classify(ticket: TicketEntity): LlmEnrichment {
    const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
    return {
      category: this.categorize(text),
      priority: this.prioritize(text),
      summary: ticket.subject.slice(0, 120),
      confidence: 0.3,
    };
  }

  private categorize(text: string): TicketCategory {
    for (const [category, keywords] of FallbackClassifier.CATEGORY_KEYWORDS) {
      if (keywords.some((k) => text.includes(k))) {
        return category;
      }
    }
    return TicketCategory.OTHER;
  }

  private prioritize(text: string): TicketPriority {
    if (FallbackClassifier.URGENT.some((k) => text.includes(k))) {
      return TicketPriority.URGENT;
    }
    if (FallbackClassifier.HIGH.some((k) => text.includes(k))) {
      return TicketPriority.HIGH;
    }
    if (FallbackClassifier.LOW.some((k) => text.includes(k))) {
      return TicketPriority.LOW;
    }
    return TicketPriority.MEDIUM;
  }
}
