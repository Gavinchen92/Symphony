import { resolve } from "node:path";
import { createHttpApp } from "./app";
import { loadRuntimeConfig } from "./config";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { Orchestrator } from "./orchestrator";
import { CodexAppServerRunner } from "./codex/runner";
import { CodexAutoStrategySelector } from "./autoStrategy";
import { GitWorktreeProvider } from "./workspace";

const config = loadRuntimeConfig();
const eventBus = new EventBus();
const db = new SymphonyDb(resolve(config.dataDir, "symphony.sqlite"), eventBus, config.projectRoot);
db.recoverInterruptedRuns();

const orchestrator = new Orchestrator({
  db,
  workspaceProvider: new GitWorktreeProvider(),
  autoStrategySelector: new CodexAutoStrategySelector(),
  agentRunner: new CodexAppServerRunner()
});

const server = createHttpApp({
  db,
  orchestrator,
  eventBus,
  webDistDir: config.webDistDir
});

server.listen(config.port, config.host, () => {
  console.log(`Symphony server listening on http://${config.host}:${config.port}`);
});
