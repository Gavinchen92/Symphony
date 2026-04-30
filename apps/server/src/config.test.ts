import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./config";

describe("runtime config env file", () => {
  it("parses local env files without exposing values to the client", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-env-"));
    const envPath = join(root, ".env.local");
    writeFileSync(
      envPath,
      [
        "# local only",
        "SYMPHONY_LLM_API_KEY=sk-local",
        'SYMPHONY_LLM_MODEL="gpt-test"',
        "export SYMPHONY_LLM_BASE_URL=https://example.test/v1 # comment",
        "INVALID LINE"
      ].join("\n")
    );

    expect(parseEnvFile(envPath)).toEqual({
      SYMPHONY_LLM_API_KEY: "sk-local",
      SYMPHONY_LLM_MODEL: "gpt-test",
      SYMPHONY_LLM_BASE_URL: "https://example.test/v1"
    });
  });
});
