import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Legacy code relies heavily on these; tighten gradually
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Legacy patterns downgraded to warnings — fix as files are touched
      "preserve-caught-error": "warn",
      "no-useless-catch": "warn",
      "no-async-promise-executor": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
    },
  }
);
