import { resolve } from "node:path";
import { createFastifyApp } from "./app";
import { loadRuntimeConfig } from "./config";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { Orchestrator } from "./orchestrator";
import { CodexAppServerRunner } from "./codex/runner";
import { AiAutoStrategySelector } from "./autoStrategy";
import { GitWorktreeProvider } from "./workspace";
import { createAiAdvisor } from "./aiAdvisor";
import { TaskFinalizer } from "./finalizer";
import { createServiceLogger } from "./logger";
import { SystemMonitor } from "./systemMonitor";

const config = loadRuntimeConfig();
const serviceLogger = createServiceLogger(config.log);
const eventBus = new EventBus();
const db = new SymphonyDb(resolve(config.dataDir, "symphony.sqlite"), eventBus, config.projectRoot);
const advisor = createAiAdvisor(config.llm);
const systemMonitor = new SystemMonitor({
  db,
  projectRoot: config.projectRoot,
  logger: serviceLogger.logger
});
systemMonitor.startProcessListeners();

eventBus.onRunEvent((event) => {
  const run = db.getRun(event.runId);
  serviceLogger.logger.info(
    {
      runId: event.runId,
      taskId: run.taskId,
      runEventId: event.id,
      runEventType: event.type
    },
    event.message
  );
});

db.recoverInterruptedRuns();

const orchestrator = new Orchestrator({
  db,
  workspaceProvider: new GitWorktreeProvider(),
  autoStrategySelector: new AiAutoStrategySelector(advisor),
  agentRunner: new CodexAppServerRunner(),
  systemMonitor
});
const finalizer = new TaskFinalizer({ db, advisor, systemMonitor });

const app = await createFastifyApp({
  db,
  orchestrator,
  finalizer,
  eventBus,
  webDistDir: config.webDistDir,
  logger: serviceLogger.logger,
  closeLogger: serviceLogger.close,
  systemMonitor
});

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { host: config.host, port: config.port, logFile: serviceLogger.logFilePath },
  "symphony_server_started"
);
