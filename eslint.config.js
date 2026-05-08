// eslint.config.js
import eslintPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  {
    ignores: ['dist/**', 'dist-test/**', 'node_modules/**', 'coverage/**', '*.tsbuildinfo'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: parser,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json'],
      },
    },
    plugins: {
      '@typescript-eslint': eslintPlugin,
      sonarjs,
    },
    rules: {
      // This is a CLI — console.log is the UI, not leftover debug output.
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
    },
  },
  {
    // Complexity ceiling for source code. Existing violators carry an inline
    // `eslint-disable-next-line ... -- TODO(complexity)` so the door is locked
    // against new bloat; grep for `TODO(complexity)` to inventory the debt.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      complexity: ['error', { max: 25 }],
      'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      'max-depth': ['error', 5],
      'max-params': ['error', 6],
      'max-statements': ['error', 60],
      'max-nested-callbacks': ['error', 4],
      'sonarjs/cognitive-complexity': ['error', 30],
      'sonarjs/no-identical-functions': 'error',
    },
  },
  {
    // node:test accepts async test/describe callbacks and handles them internally,
    // so the floating-promise/misused-promise rules produce false positives there.
    // Tests legitimately get long (table-driven cases, fixtures, mocks) so
    // complexity caps don't apply.
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
];
