import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace contracts package from SOURCE. Its package.json
      // "main" points at dist/, which only exists after `tsc --build`; without
      // this alias `npm test` fails on a fresh clone until a build has run.
      "@onboardos/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Exclude compiled output -- only run tests from source .ts files
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.aws-sam/**",
    ],
    include: [
      "**/src/**/*.test.ts",
      // Operator tooling (provisioning script logic), tested with fake AWS clients
      "scripts/**/*.test.ts",
      // Infrastructure invariants asserted against infrastructure/template.yaml
      "infrastructure/**/*.test.ts",
    ],
  },
});
