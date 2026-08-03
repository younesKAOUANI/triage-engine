import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { EnvVars, envSchema } from './env.validation';

/**
 * TypeORM connection options, built once and shared by two callers:
 *  - the Nest runtime (TypeOrmModule.forRootAsync), and
 *  - the migration CLI (`npm run migration:*`), which imports the default export.
 *
 * Keeping a single builder means the app and the migration tooling can never
 * drift onto different schemas/credentials.
 *
 * `synchronize` is hard-wired to false: schema changes go through explicit,
 * reviewable migrations only (a hard requirement of this project).
 */
export function buildDataSourceOptions(env: EnvVars): DataSourceOptions {
  // When compiled, this file lives in dist/config and entities/migrations are
  // .js; under ts-node they're .ts in src/. Detect from our own extension.
  const isCompiled = __filename.endsWith('.js');
  const ext = isCompiled ? 'js' : 'ts';
  const root = join(__dirname, '..');

  return {
    type: 'postgres',
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    username: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
    synchronize: false,
    // Entities are also auto-loaded by Nest via autoLoadEntities; the glob keeps
    // the CLI (which has no Nest container) able to resolve them too.
    entities: [join(root, '**', `*.entity.${ext}`)],
    migrations: [join(root, 'migrations', `*.${ext}`)],
    migrationsTableName: 'typeorm_migrations',
    logging:
      env.NODE_ENV === 'development'
        ? ['error', 'warn', 'migration']
        : ['error'],
  };
}

/**
 * Default export consumed by the TypeORM CLI. The CLI runs outside Nest, so we
 * load and validate the environment ourselves here.
 */
loadDotenv();
const env = envSchema.parse(process.env);
export default new DataSource(buildDataSourceOptions(env));
