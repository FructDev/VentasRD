import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["apps/pos/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    // El cliente nativo no usa next/image ni el router Next.
    rules: {"@next/next/no-img-element": "off", "@next/next/no-html-link-for-pages": "off"},
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "apps/pos/dist/**",
    "apps/pos/src-tauri/gen/schemas/**",
    "coverage/**",
    "node_modules/**",
    "**/*.min.js",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
