import pkg from '@eslint/js';
const { configs } = pkg;

export default [
  {
    ignores: ["node_modules/", "dist/", "build/", ".cache/"],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  {
    rules: {
      "no-unused-vars": "warn",
      "no-console": "warn",
      "no-debugger": "error",
      "eqeqeq": "error",
      "curly": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
      "indent": ["error", 2],
      "arrow-spacing": ["error", { before: true, after: true }],
      "object-curly-spacing": ["error", "always"],
    },
  },
  {
    plugins: {
      eslintRecommended: configs.recommended,
    },
  },
];
