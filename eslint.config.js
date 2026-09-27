import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "dist/", "coverage/", ".wrangler/"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-implicit-coercion": "error",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  { files: ["js/**", "ui/**", "config/**"], languageOptions: { globals: { ...globals.browser } } },
  { files: ["worker/**"], languageOptions: { globals: { ...globals.serviceworker } } },
  { files: ["tests/**", "scripts/**", "eslint.config.js"], languageOptions: { globals: { ...globals.node } } },
];
