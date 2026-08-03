import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // bundle/ holds generated output, so linting it would only report on code
    // esbuild wrote.
    ignores: ['**/dist/**', '**/bundle/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Tool config files live outside the build tsconfig on purpose, since
          // they are never compiled into dist.
          allowDefaultProject: ['*.config.ts', 'apps/*/*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      // node:test returns a promise by design, and awaiting every call would only
      // add noise without changing how the runner reports results.
      '@typescript-eslint/no-floating-promises': 'off',
      // Tests assert on values the compiler already knows, which is the point:
      // the assertion fails if the shape ever changes.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Test helpers take an async callback so they can await it, and a body that
      // happens to be synchronous still has to match that signature.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // The service worker is plain JavaScript served as it is written, never
    // compiled, and it runs against globals no browser page has.
    files: ['apps/tunnelcode-server/web/public/sw.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
      },
    },
  },
  {
    // Build scripts are plain JavaScript run by node, never compiled, so there is
    // no project for the type-aware rules to use.
    files: ['eslint.config.js', '**/scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Spread first: disableTypeChecked sets its own parserOptions, and replacing
      // the whole block would put the parser back to needing a project.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
  prettier,
);
