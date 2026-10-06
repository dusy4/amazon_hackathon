import { defineConfig } from "vitest/config";

// Tests run against the local backends by default so they never write into the live demo
// DynamoDB table or spend Bedrock tokens. dotenv does not override variables that are already set.
// Set SP_TEST_AWS=1 to run the suite against whatever .env configures.
const local = process.env.SP_TEST_AWS ? {} : { SP_AGENT: "rules", SP_LLM: "", SP_RERANK: "", SP_EMBEDDINGS: "local", SP_MEMORY: "file" };

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, env: local },
});
