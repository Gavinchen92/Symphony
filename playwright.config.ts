import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 4318;
const baseURL = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "symphony-e2e-"));
const envPrefix = `SYMPHONY_PORT=${port} SYMPHONY_DATA_DIR=${shellQuote(dataDir)}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  reporter: "list",
  webServer: {
    command: `pnpm --filter @symphony/web build && ${envPrefix} pnpm --filter @symphony/server exec tsx src/index.ts`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000
  },
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
