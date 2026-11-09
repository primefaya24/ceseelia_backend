import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      STAGE: "dev",
      // Tests must never reach real AWS. Fake credentials plus an endpoint on a closed local
      // port make any SDK call that isn't mocked fail fast instead of writing to the dev table.
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_SESSION_TOKEN: "",
      AWS_PROFILE: "",
      AWS_ENDPOINT_URL: "http://127.0.0.1:9",
    },
  },
});
