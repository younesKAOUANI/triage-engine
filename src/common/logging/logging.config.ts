import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { EnvVars } from '../../config/env.validation';
import {
  CORRELATION_HEADER,
  getCorrelationId,
} from '../correlation/correlation';

/**
 * Pino configuration for nestjs-pino. The important part is `mixin`: it reads the
 * correlation id from AsyncLocalStorage on every log line, so the same id is
 * stamped on logs emitted by HTTP handlers, queue workers, the outbox relay, and
 * the Mistral client alike — without passing it around explicitly.
 *
 * Output is pretty (single line) in development and raw JSON everywhere else, so
 * production/test logs are machine-parseable.
 */
export function buildLoggerParams(env: EnvVars): Params {
  const isDev = env.NODE_ENV === 'development';

  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: (req, res) => {
        const id =
          getCorrelationId() ??
          (req.headers[CORRELATION_HEADER] as string | undefined) ??
          randomUUID();
        res.setHeader(CORRELATION_HEADER, id);
        return id;
      },
      mixin() {
        const correlationId = getCorrelationId();
        return correlationId ? { correlationId } : {};
      },
      autoLogging: {
        // Health/metrics scrapes are noisy and uninteresting — don't log them.
        ignore: (req) =>
          req.url === '/health' ||
          req.url === '/ready' ||
          req.url === '/metrics',
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        remove: true,
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:standard' },
          }
        : undefined,
    },
  };
}
