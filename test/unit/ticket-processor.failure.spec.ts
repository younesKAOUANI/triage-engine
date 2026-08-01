import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { PipelineJobData } from '../../src/pipeline/pipeline.constants';
import { TicketProcessor } from '../../src/pipeline/ticket.processor';

/**
 * Terminal-failure classification in the worker's `failed` handler.
 *
 * These are unit tests on purpose. The integration suite proves the two paths a
 * request can actually reach (attempt exhaustion, and an UnrecoverableError),
 * but the remaining branches have no trigger from an HTTP request: `job.discard()`
 * and a backoff of -1 are never used by this codebase, and "Redis is wedged
 * mid-probe" cannot be staged against a healthy Testcontainers Redis. Those
 * branches are precisely where a silent loss would hide, so they are exercised
 * here against a fake Job instead of left uncovered.
 */
describe('TicketProcessor.onFailed — terminal failure classification', () => {
  const MAX_ATTEMPTS = 5;

  let dlq: { recordDeadLetter: jest.Mock };
  let inc: jest.Mock;
  let processor: TicketProcessor;

  beforeAll(() => {
    Logger.overrideLogger(false); // silence Nest's console logger
  });

  beforeEach(() => {
    dlq = { recordDeadLetter: jest.fn().mockResolvedValue(undefined) };
    inc = jest.fn();
    processor = new TicketProcessor(
      null as never, // tickets
      null as never, // enricher
      null as never, // outbox
      null as never, // dataSource
      { eventsFailed: { inc } } as never, // metrics
      dlq as never,
      null as never, // producer
      {} as never, // env
    );
  });

  const makeJob = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 'job-1',
      attemptsMade: 1,
      opts: { attempts: MAX_ATTEMPTS },
      data: { idempotencyKey: 'k-1', ticketId: 't-1', eventId: 'e-1' },
      isFailed: jest.fn().mockResolvedValue(false),
      ...over,
    }) as unknown as Job<PipelineJobData>;

  const dispositions = () => inc.mock.calls.map((c) => c[0]?.disposition);

  // ── Terminal despite attempts remaining ────────────────────────────────────

  it('dead-letters an UnrecoverableError while attempts remain', async () => {
    await processor.onFailed(
      makeJob(),
      new UnrecoverableError('stalled out'),
    );
    expect(dlq.recordDeadLetter).toHaveBeenCalledTimes(1);
  });

  it('dead-letters an UnrecoverableError identified only by name', async () => {
    // A duplicate bullmq copy in the dep tree defeats `instanceof`; the name
    // check is the fallback, and is otherwise never executed by any test.
    const error = new Error('job stalled more than allowable limit');
    error.name = 'UnrecoverableError';
    await processor.onFailed(makeJob(), error);
    expect(dlq.recordDeadLetter).toHaveBeenCalledTimes(1);
  });

  it('dead-letters via the isFailed() backstop (discard / backoff -1)', async () => {
    // Not unrecoverable, attempts remain — but BullMQ has already parked the job
    // in the failed set. This is the only cover for job.discard() and a backoff
    // strategy returning -1.
    const job = makeJob({ isFailed: jest.fn().mockResolvedValue(true) });
    await processor.onFailed(job, new Error('discarded'));
    expect(dlq.recordDeadLetter).toHaveBeenCalledTimes(1);
  });

  it('dead-letters on the final attempt', async () => {
    await processor.onFailed(
      makeJob({ attemptsMade: MAX_ATTEMPTS }),
      new Error('boom'),
    );
    expect(dlq.recordDeadLetter).toHaveBeenCalledTimes(1);
  });

  // ── Not terminal ───────────────────────────────────────────────────────────

  it('counts a retry and writes NO dead letter mid-budget', async () => {
    await processor.onFailed(makeJob(), new Error('transient'));
    expect(dlq.recordDeadLetter).not.toHaveBeenCalled();
    expect(dispositions()).toEqual(['retry']);
  });

  // ── Failing safe when classification itself fails ──────────────────────────

  it('assumes terminal when the isFailed() probe rejects', async () => {
    // Redis may be the thing that is broken. A spurious dead letter is
    // self-correcting (replay re-enters through the same idempotency key); a
    // missed one is a silent loss.
    const job = makeJob({
      isFailed: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await processor.onFailed(job, new Error('transient'));
    expect(dlq.recordDeadLetter).toHaveBeenCalledTimes(1);
    // ...and it must NOT be reported as a lost dead letter.
    expect(dispositions()).not.toContain('dead_letter_write_failed');
  });

  it('assumes terminal when the isFailed() probe hangs', async () => {
    const job = makeJob({ isFailed: jest.fn().mockReturnValue(new Promise(() => {})) });
    await processor.onFailed(job, new Error('transient'));
    expect(dlq.recordDeadLetter).toHaveBeenCalledTimes(1);
  }, 10000);

  // ── The handler must never reject ──────────────────────────────────────────

  it('does not reject when the dead-letter write fails, and flags it', async () => {
    dlq.recordDeadLetter.mockRejectedValue(new Error('postgres down'));
    await expect(
      processor.onFailed(makeJob({ attemptsMade: MAX_ATTEMPTS }), new Error('boom')),
    ).resolves.toBeUndefined();
    expect(dispositions()).toContain('dead_letter_write_failed');
  });

  it('does not reject when the retry bookkeeping itself throws', async () => {
    inc.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    await expect(
      processor.onFailed(makeJob(), new Error('transient')),
    ).resolves.toBeUndefined();
  });

  it('does not reject when the error object is malformed', async () => {
    await expect(
      processor.onFailed(makeJob(), undefined as unknown as Error),
    ).resolves.toBeUndefined();
  });
});
