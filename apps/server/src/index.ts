import { resolve } from "node:path";
import { createHttpApp } from "./app";
import { loadRuntimeConfig } from "./config";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { Orchestrator } from "./orchestrator";
import { CodexAppServerRunner } from "./codex/runner";
import { AiAutoStrategySelector } from "./autoStrategy";
import { GitWorktreeProvider } from "./workspace";
import { createAiAdvisor } from "./aiAdvisor";
import { TaskFinalizer } from "./finalizer";

const config = loadRuntimeConfig();
const eventBus = new EventBus();
const db = new SymphonyDb(resolve(config.dataDir, "symphony.sqlite"), eventBus, config.projectRoot);
const advisor = createAiAdvisor(config.llm);
db.recoverInterruptedRuns();

const orchestrator = new Orchestrator({
  db,
  workspaceProvider: new GitWorktreeProvider(),
  autoStrategySelector: new AiAutoStrategySelector(advisor),
  agentRunner: new CodexAppServerRunner()
});
const finalizer = new TaskFinalizer({ db, advisor });

const server = createHttpApp({
  db,
  orchestrator,
  finalizer,
  eventBus,
  webDistDir: config.webDistDir
});

server.listen(config.port, config.host, () => {
  console.log(`Symphony server listening on http://${config.host}:${config.port}`);
});
