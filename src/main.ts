import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
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

  const env = app.get<EnvVars>(APP_ENV);
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
