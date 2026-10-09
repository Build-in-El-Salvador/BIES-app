import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// Flat config for the Vite + React frontend (src/). The prior repo had no ESLint
// config at all, so `npm run lint` could not run. This makes the gate operative;
// high-volume stylistic rules start relaxed and can be tightened over time. Real
// correctness rules (rules-of-hooks, no-undef, undefined JSX components) stay on.
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'server/**',
      'bugs/**',
      'e2e/**',
      'relay-proxy/**',
      'coverage/**',
      'public/**',
      // Capacitor copies the built web bundle into the iOS app. It is minified
      // build output, not source — linting it produced 165 of 176 total errors.
      'ios/**',
      '*.config.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
        __APP_VERSION__: 'readonly', // Vite define() build-time constant
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // JSX runtime (Vite/React 17+) — no need to import React in scope.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      // Keep the real bug-catchers strict.
      'react-hooks/rules-of-hooks': 'error',
      'react/jsx-no-undef': 'error',
      // Relaxed for the initial operative gate (large existing backlog).
      'react-hooks/exhaustive-deps': 'off',
      'react/no-unknown-property': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-cond-assign': 'off',
      'no-fallthrough': 'off',
      'no-async-promise-executor': 'off',
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
];
