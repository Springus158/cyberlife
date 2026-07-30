export default [
  {
    files: ['src/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', navigator: 'readonly', localStorage: 'readonly',
        FileReader: 'readonly', Blob: 'readonly', URL: 'readonly',
        CustomEvent: 'readonly', Image: 'readonly', atob: 'readonly', btoa: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', requestAnimationFrame: 'readonly',
        ResizeObserver: 'readonly', MutationObserver: 'readonly', getComputedStyle: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly', Event: 'readonly',
        DOMParser: 'readonly', performance: 'readonly', structuredClone: 'readonly',
        crypto: 'readonly', NodeFilter: 'readonly', Range: 'readonly',
        CSS: 'readonly', Highlight: 'readonly', HTMLElement: 'readonly', Node: 'readonly',
      },
    },
    rules: {
      // The rule that would have caught this review's two broken imports
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
];
