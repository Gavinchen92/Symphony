import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeLogLevel, type LogRuntimeConfig } from "./logger";

export type RuntimeConfig = {
  host: string;
  port: number;
  projectRoot: string;
  dataDir: string;
  webDistDir: string;
  log: LogRuntimeConfig;
  llm: LlmRuntimeConfig;
};

export type LlmRuntimeConfig = {
  provider: string;
  apiKey: string | null;
  model: string | null;
  baseUrl: string;
  enabled: boolean;
};

export function loadRuntimeConfig(): RuntimeConfig {
  const projectRoot = findProjectRoot(process.cwd());
  const env = loadLocalEnv(projectRoot);
  const dataDir = env.SYMPHONY_DATA_DIR ?? resolve(projectRoot, "data");

  return {
    host: env.SYMPHONY_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.SYMPHONY_PORT ?? "4317", 10),
    projectRoot,
    dataDir,
    webDistDir: resolve(projectRoot, "apps/web/dist"),
    log: {
      level: normalizeLogLevel(env.SYMPHONY_LOG_LEVEL),
      dir: env.SYMPHONY_LOG_DIR ?? resolve(dataDir, "logs"),
      stdout: env.NODE_ENV !== "test"
    },
    llm: loadLlmConfig(env)
  };
}

function loadLlmConfig(env: Record<string, string | undefined>): LlmRuntimeConfig {
  const apiKey = env.SYMPHONY_LLM_API_KEY?.trim() || null;
  const model = env.SYMPHONY_LLM_MODEL?.trim() || null;
  const baseUrl = (env.SYMPHONY_LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
    /\/+$/,
    ""
  );
  const provider = env.SYMPHONY_LLM_PROVIDER?.trim() || "openai-compatible";

  return {
    provider,
    apiKey,
    model,
    baseUrl,
    enabled: Boolean(apiKey && model)
  };
}

function loadLocalEnv(projectRoot: string): Record<string, string | undefined> {
  const localEnv = parseEnvFile(resolve(projectRoot, ".env.local"));
  return {
    ...localEnv,
    ...process.env
  };
}

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const entries: Record<string, string> = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!key) {
      continue;
    }
    const rawValue = match[2] ?? "";
    entries[key] = normalizeEnvValue(rawValue);
  }
  return entries;
}

function normalizeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replaceAll("\\n", "\n");
  }
  return trimmed.replace(/\s+#.*$/, "");
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
