// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsBuildInfoFile: "./out/.tsbuildinfo",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-namespace": "off",
      "no-throw-literal": "warn",
      semi: "warn",
      curly: "warn",
      eqeqeq: "warn",
    },
  },
  {
    ignores: ["out/", "node_modules/", ".vscode-test/", "**/*.js", "**/*.mjs"],
  }
);
