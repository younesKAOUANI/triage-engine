import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat config (ESLint 9).
 *
 * The rules that earn their place here are the ones that catch the class of bug
 * this codebase is actually about: a promise nobody awaited. A fire-and-forget
 * async call in a worker event handler is how a dead letter goes missing, and
 * no amount of type-checking finds it. `no-floating-promises` and
 * `no-misused-promises` need type information, hence projectService.
 *
 * Formatting is left to Prettier: `prettier` last switches off every stylistic
 * rule so the two never disagree.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Both projects listed explicitly: tsconfig.json excludes `test`, so
        // relying on project discovery leaves every spec unparseable.
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The point of having a linter on this project.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Deliberate: `catch (e)` on an unknown error and the odd cast at a
      // library boundary are normal here, and the codebase documents each one.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests reach into internals and build deliberately malformed objects.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
