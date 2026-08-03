import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { READS_ONLY } from '../common/rate-limit/rate-limit.module';
import { TicketEntity } from './entities/ticket.entity';
import { TicketsService } from './tickets.service';

// Read-only: charge against the read bucket, not the tighter write one.
@SkipThrottle(READS_ONLY)
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.findByIdOrThrow(id);
    return this.toView(ticket);
  }

  /** Shape the entity into a stable public response (and keep internals out). */
  private toView(t: TicketEntity) {
    return {
      id: t.id,
      subject: t.subject,
      body: t.body,
      requesterEmail: t.requesterEmail,
      enrichment: {
        status: t.enrichmentStatus,
        source: t.enrichmentSource,
        category: t.category,
        priority: t.priority,
        summary: t.summary,
        confidence: t.confidence,
        attempts: t.enrichmentAttempts,
        enrichedAt: t.enrichedAt,
      },
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
