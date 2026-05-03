// eslint.config.js
import eslintPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: parser,
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    plugins: {
      "@typescript-eslint": eslintPlugin
    },
    rules: {
      // This is a CLI — console.log is the UI, not leftover debug output.
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true
      }]
    }
  }
];