import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored noVNC and separately-built packages with their own tooling
    "public/novnc/**",
    "backend/**",
    "license-server/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
