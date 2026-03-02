// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["out/", "node_modules/", ".vscode-test/", "**/*.js", "**/*.mjs"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsBuildInfoFile: "./out/.tsbuildinfo",
      },
    },
    rules: {
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Enforce but don't block on explicit-any (existing code has some)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow void for fire-and-forget promises (common in VS Code extensions)
      "@typescript-eslint/no-confusing-void-expression": "off",
      // Allow non-null assertions (common with VS Code API patterns)
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow empty functions (dispose patterns, catch blocks)
      "@typescript-eslint/no-empty-function": "off",
      // Relax restrict-template-expressions for logging
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "no-throw-literal": "off",
      "@typescript-eslint/only-throw-error": "warn",
      semi: "warn",
      curly: "warn",
      eqeqeq: "warn",
    },
  }
);
