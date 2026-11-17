import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noVscode = {
  patterns: [
    {
      group: ['vscode'],
      message: 'Only src/ext and src/extension.ts may import vscode, so the rest runs under plain Node.',
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.vscode-test/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts', 'src/webview/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', noVscode] },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', 'test/fake-entire/entire'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        suite: 'readonly',
        suiteSetup: 'readonly',
        suiteTeardown: 'readonly',
        test: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
