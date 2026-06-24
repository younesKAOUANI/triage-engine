import { Module } from '@nestjs/common';
import { ENRICHER } from '../pipeline/enricher.port';
import { AiEnricher } from './ai.enricher';
import { FallbackClassifier } from './fallback.classifier';
import { MistralCircuitBreaker } from './mistral.circuit-breaker';
import { MistralClient } from './mistral.client';

/**
 * The AI enrichment layer. It provides the concrete ENRICHER that the pipeline
 * depends on — swapping in here is the only change needed to add AI on top of the
 * core engine (the processor still depends only on the Enricher interface).
 */
@Module({
  providers: [
    MistralClient,
    MistralCircuitBreaker,
    FallbackClassifier,
    AiEnricher,
    { provide: ENRICHER, useExisting: AiEnricher },
  ],
  exports: [ENRICHER],
})
export class EnrichmentModule {}
