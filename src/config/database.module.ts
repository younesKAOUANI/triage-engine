import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_ENV } from './app-config.module';
import { buildDataSourceOptions } from './data-source';
import { EnvVars } from './env.validation';

/**
 * Wires TypeORM into Nest using the SAME options builder the migration CLI uses,
 * with two runtime-only adjustments:
 *  - autoLoadEntities: entities register themselves via TypeOrmModule.forFeature
 *    in each domain module (so we drop the file glob here to avoid double
 *    registration), and
 *  - migrationsRun: optionally apply pending migrations on boot for the demo
 *    stack. In production you'd prefer an explicit migration step in the deploy
 *    pipeline over running them at app startup.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: EnvVars) => {
        const { entities: _glob, ...base } = buildDataSourceOptions(env);
        return {
          ...base,
          autoLoadEntities: true,
          migrationsRun: env.DB_RUN_MIGRATIONS_ON_BOOT,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
