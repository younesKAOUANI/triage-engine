import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnvVars, envSchema, validateEnv } from './env.validation';

/** DI token for the fully-typed, validated environment. */
export const APP_ENV = Symbol('APP_ENV');

/**
 * Wraps @nestjs/config and additionally exposes the validated env as a single
 * strongly-typed object under APP_ENV. Inject it with `@Inject(APP_ENV) env: EnvVars`
 * to get autocompletion and correct types everywhere, instead of the stringly
 * `ConfigService.get('KEY')` dance.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: APP_ENV,
      // validateEnv already guaranteed this parses; re-parsing yields the typed,
      // coerced object (numbers/booleans rather than raw strings).
      useFactory: (): EnvVars => envSchema.parse(process.env),
    },
  ],
  exports: [APP_ENV, ConfigModule],
})
export class AppConfigModule {}
