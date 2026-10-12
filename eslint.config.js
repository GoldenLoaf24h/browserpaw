import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  // Global ignores first - these apply to all configurations
  {
    ignores: [
      'node_modules/',
      '**/dist/**',
      '**/.output/**',
      '**/.wxt/**',
      'logs/',
      '*.log',
      '.cache/',
      '.temp/',
      '.idea/',
      '.DS_Store',
      'Thumbs.db',
      '*.zip',
      '*.tar.gz',
      'stats.html',
      'stats-*.json',
      'pnpm-lock.yaml',
      '**/workers/**',
      'app/**/workers/**',
      'packages/**/workers/**',
      'test-inject-script.js',
      'app/chrome-extension/libs/**',
      'app/chrome-extension/public/libs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.{js,mjs,cjs}', 'bin/*.cjs', 'plugins/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/**/*.cjs', 'bin/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // Global rule adjustments
  {
    // Allow intentionally empty catch blocks (common in extension code),
    // while keeping other empty blocks reported.
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['app/**/*.{js,jsx,ts,tsx}', 'packages/**/*.{js,jsx,ts,tsx}'],
    ignores: ['**/workers/**'], // Additional ignores for this specific config
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['app/chrome-extension/**/*.{js,mjs,cjs,ts,vue}'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  ...pluginVue.configs['flat/essential'],
  {
    files: ['app/chrome-extension/**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  eslintConfigPrettier,
);
