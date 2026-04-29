import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RuntimeConfig = {
  host: string;
  port: number;
  projectRoot: string;
  dataDir: string;
  webDistDir: string;
};

export function loadRuntimeConfig(): RuntimeConfig {
  const projectRoot = findProjectRoot(process.cwd());
  const dataDir = process.env.SYMPHONY_DATA_DIR ?? resolve(projectRoot, "data");

  return {
    host: process.env.SYMPHONY_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.SYMPHONY_PORT ?? "4317", 10),
    projectRoot,
    dataDir,
    webDistDir: resolve(projectRoot, "apps/web/dist")
  };
}

function findProjectRoot(start: string): string {
  let current = resolve(start);

  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (packageJson.name === "symphony-local-runner") {
          return current;
        }
      } catch {
        // Ignore malformed package.json while walking upward.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

