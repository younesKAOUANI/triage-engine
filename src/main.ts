import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import {
  CORRELATION_HEADER,
  correlationStorage,
} from './common/correlation/correlation';
import { APP_ENV } from './config/app-config.module';
import { EnvVars } from './config/env.validation';

async function bootstrap(): Promise<void> {
  // bufferLogs so nothing logs with the default logger before Pino is installed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  // Correlation middleware, registered via the raw adapter so it runs BEFORE any
  // module-level middleware (pino-http) and every route handler. It opens the
  // AsyncLocalStorage scope that the logger mixin and the whole request chain
  // read from. Inbound x-correlation-id is honoured (lets a caller trace a
  // request end-to-end); otherwise we mint one.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    res.setHeader(CORRELATION_HEADER, correlationId);
    correlationStorage.run({ correlationId }, () => next());
  });

  // Behind a reverse proxy, every request otherwise appears to originate from
  // the proxy, which collapses per-IP rate limiting into a single shared bucket
  // and puts the proxy's address in the logs. Only enable it when a proxy is
  // genuinely in front: trusting X-Forwarded-For when it is not lets a caller
  // spoof their own address and bypass the limit.
  const envVars = app.get<EnvVars>(APP_ENV);
  if (envVars.TRUST_PROXY) {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  // Static demo assets. `index: false` matters: with it enabled express would
  // answer `/` before the router does, and the JSON index that curl relies on
  // would become unreachable.
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    index: false,
    maxAge: '1h',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Lets OnModuleDestroy hooks (Redis quit, BullMQ close, relay stop) run on
  // SIGTERM so in-flight work drains instead of being severed.
  app.enableShutdownHooks();

  await app.listen(envVars.PORT, '0.0.0.0');
}

void bootstrap();
