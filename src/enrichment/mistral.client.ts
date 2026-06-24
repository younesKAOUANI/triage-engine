import { Inject, Injectable } from '@nestjs/common';
import { Mistral } from '@mistralai/mistralai';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { TransientEnrichmentError } from './errors';
import { LlmEnrichment, llmEnrichmentSchema } from './llm-response.schema';
import { buildUserPrompt, ENRICHMENT_SYSTEM_PROMPT } from './prompts';

/**
 * Thin boundary around the official Mistral SDK. Responsibilities:
 *  - one well-prompted JSON-mode call,
 *  - a hard per-call timeout (AbortController) so a hung request can't stall the
 *    worker — the breaker's timeout is a backstop, this actually aborts the HTTP,
 *  - parse + zod-validate the response and surface ANY problem as a
 *    TransientEnrichmentError (ADR-0005), so the breaker and retry loop treat a
 *    bad/garbage response the same as a network failure.
 *
 * The API key is read from env only. With no key the client is "not configured"
 * and the enricher degrades to the fallback without ever attempting a call.
 * `serverURL` is overridable so tests can point the SDK at a local mock and
 * exercise the real client against a fake HTTP boundary (nothing internal mocked).
 */
@Injectable()
export class MistralClient {
  private readonly client: Mistral | null;

  constructor(@Inject(APP_ENV) private readonly env: EnvVars) {
    this.client = env.MISTRAL_API_KEY
      ? new Mistral({
          apiKey: env.MISTRAL_API_KEY,
          serverURL: env.MISTRAL_SERVER_URL || undefined,
          // We own retries (with jitter) and the breaker; disable the SDK's.
          retryConfig: { strategy: 'none' },
        })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async classify(ticket: TicketEntity): Promise<LlmEnrichment> {
    if (!this.client) {
      throw new TransientEnrichmentError('mistral API key not configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.env.MISTRAL_TIMEOUT_MS,
    );
    try {
      const response = await this.client.chat.complete(
        {
          model: this.env.MISTRAL_MODEL,
          temperature: 0,
          maxTokens: 300,
          responseFormat: { type: 'json_object' },
          messages: [
            { role: 'system', content: ENRICHMENT_SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(ticket) },
          ],
        },
        { fetchOptions: { signal: controller.signal } },
      );
      return this.parseAndValidate(this.extractContent(response));
    } catch (error) {
      if (error instanceof TransientEnrichmentError) {
        throw error;
      }
      // Network error, abort/timeout, non-2xx — all transient.
      throw new TransientEnrichmentError(
        `mistral call failed: ${(error as Error).message}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private extractContent(response: {
    choices?: Array<{ message?: { content?: unknown } }>;
  }): string {
    const content = response.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.length > 0) {
      return content;
    }
    // JSON mode returns a string; tolerate the chunked-content shape just in case.
    if (Array.isArray(content)) {
      const text = content
        .map((chunk) =>
          chunk && typeof chunk === 'object' && 'text' in chunk
            ? String((chunk as { text: unknown }).text)
            : '',
        )
        .join('');
      if (text.length > 0) {
        return text;
      }
    }
    throw new TransientEnrichmentError('mistral returned empty content');
  }

  private parseAndValidate(content: string): LlmEnrichment {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new TransientEnrichmentError('mistral returned non-JSON content');
    }
    const parsed = llmEnrichmentSchema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new TransientEnrichmentError(
        `mistral response failed validation: ${detail}`,
      );
    }
    return parsed.data;
  }
}
