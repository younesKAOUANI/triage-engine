/**
 * Unit-test config (`npm run test:unit`).
 *
 * The project's primary suite is the integration suite (`test/jest-e2e.json`),
 * which runs against real Postgres and Redis — see the README for why. This
 * config exists for the narrow set of pure-logic units whose interesting
 * branches CANNOT be forced through the real queue: notably the worker's
 * terminal-failure classification, where BullMQ paths like `job.discard()` and a
 * wedged Redis connection have no reachable trigger from an HTTP request.
 *
 * `testMatch` is scoped to test/unit so this never picks up the integration
 * spec, which must only ever run under the e2e config (it needs Testcontainers).
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
};
