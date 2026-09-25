import { defineWorkspace } from "vitest/config";

// Live tests hit real, unauthenticated AWS/Azure pricing endpoints and are opt-in
// (`pnpm test:live`), kept out of the default offline suite by filename convention.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["packages/*/src/**/*.test.ts"],
      exclude: ["packages/*/src/**/*.live.test.ts"],
    },
  },
  {
    test: {
      name: "live",
      include: ["packages/*/src/**/*.live.test.ts"],
      testTimeout: 20_000,
    },
  },
]);
