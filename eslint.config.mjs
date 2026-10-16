import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';
import prettier from 'eslint-config-prettier';

/**
 * ESLint 9 flat config.
 *
 * The rules that matter in a TEST suite are not the style ones — Prettier
 * handles those. They are the ones that catch a test which cannot fail:
 *
 *   no-floating-promises      an un-awaited assertion resolves to a truthy
 *                             Promise and the test passes having checked nothing
 *   require-await             an async function with no await is usually a
 *                             forgotten await somewhere inside it
 *   playwright/no-wait-for-timeout   a fixed sleep is the symptom of not having
 *                             identified the real condition
 *   playwright/no-skipped-test       a skipped test with no ticket is coverage
 *                             that silently disappeared
 *   playwright/expect-expect  a test body with no assertion at all
 *
 * `prettier` is last so it switches off every rule that would fight the
 * formatter.
 */
export default tseslint.config(
    {
        ignores: [
            'node_modules/',
            'playwright-report/',
            'test-results/',
            'blob-report/',
            // The flat config itself is not part of the TypeScript project, so
            // the type-aware rules cannot analyse it.
            'eslint.config.mjs',
        ],
    },

    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,

    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },

    {
        files: ['tests/**/*.ts'],
        ...playwright.configs['flat/recommended'],
        rules: {
            ...playwright.configs['flat/recommended'].rules,
            'playwright/no-wait-for-timeout': 'error',
            'playwright/no-skipped-test': 'error',
            'playwright/expect-expect': 'error',
            'playwright/no-conditional-in-test': 'warn',
            // Deliberately relaxed: the messaging specs legitimately await a
            // promise rejection to prove a negative.
            'playwright/no-standalone-expect': 'off',
        },
    },

    prettier,
);
