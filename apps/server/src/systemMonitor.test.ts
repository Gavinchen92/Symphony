import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { createServiceLogger } from "./logger";
import { SystemMonitor } from "./systemMonitor";

describe("SystemMonitor", () => {
  it("does not create tasks when self monitor is disabled", () => {
    const fixture = createFixture();
    try {
      fixture.db.saveSettings({
        workspaceRoot: join(fixture.root, ".workspaces"),
        maxConcurrentAgents: 1,
        selfMonitor: { enabled: false, cooldownMinutes: 30 }
      });

      const result = fixture.monitor.report({
        source: "process",
        error: new Error("启动失败")
      });

      expect(result).toBeNull();
      expect(fixture.db.listTasksWithLatestRun()).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("deduplicates repeated errors by fingerprint", () => {
    const fixture = createFixture();
    try {
      const error = new Error("队列调度器异常");
      const first = fixture.monitor.report({ source: "process", error });
      const second = fixture.monitor.report({ source: "process", error });

      expect(first?.createdTask).toBe(true);
      expect(second?.createdTask).toBe(false);
      expect(fixture.db.listTasksWithLatestRun()).toHaveLength(1);
      expect(second?.incident.occurrences).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("creates a new task after a terminal task passes cooldown", () => {
    const fixture = createFixture();
    try {
      fixture.db.saveSettings({
        workspaceRoot: join(fixture.root, ".workspaces"),
        maxConcurrentAgents: 1,
        selfMonitor: { enabled: true, cooldownMinutes: 30 }
      });
      const error = new Error("Fastify 响应管线异常");
      const first = fixture.monitor.report({
        source: "fastify",
        error,
        now: new Date("2026-04-30T00:00:00.000Z")
      });
      expect(first?.task).not.toBeNull();
      fixture.db.updateTaskStatus(first!.task!.id, "cancelled");

      const withinCooldown = fixture.monitor.report({
        source: "fastify",
        error,
        now: new Date("2026-04-30T00:10:00.000Z")
      });
      const afterCooldown = fixture.monitor.report({
        source: "fastify",
        error,
        now: new Date("2026-04-30T00:41:00.000Z")
      });

      expect(withinCooldown?.createdTask).toBe(false);
      expect(afterCooldown?.createdTask).toBe(true);
      expect(fixture.db.listTasksWithLatestRun()).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it("binds generated repair tasks to the Symphony repository", () => {
    const fixture = createFixture();
    try {
      const result = fixture.monitor.report({
        source: "process",
        error: new Error("bootstrap failed")
      });
      const task = result?.task;
      expect(task).not.toBeNull();

      const repository = fixture.db.getRepository(task!.repositoryId!);
      expect(repository.path).toBe(fixture.root);
      expect(repository.name).toBe("Symphony");
      expect(task?.labels).toEqual(["system-monitor", "auto-created"]);
    } finally {
      fixture.close();
    }
  });

  it("does not persist secrets or raw payloads in generated task descriptions", () => {
    const fixture = createFixture();
    try {
      const result = fixture.monitor.report({
        source: "fastify",
        error: new Error("request failed authorization=Bearer secret-token apiKey=sk-secret1234567890"),
        context: {
          method: "POST",
          url: "/api/internal",
          body: { apiKey: "sk-body-secret" },
          headers: { authorization: "Bearer header-secret" }
        }
      });

      expect(result?.task?.description).not.toContain("sk-secret1234567890");
      expect(result?.task?.description).not.toContain("sk-body-secret");
      expect(result?.task?.description).not.toContain("header-secret");
      expect(result?.task?.description).toContain("POST");
    } finally {
      fixture.close();
    }
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "symphony-system-monitor-"));
  const eventBus = new EventBus();
  const db = new SymphonyDb(join(root, "db.sqlite"), eventBus, root);
  const logger = createServiceLogger({
    level: "silent",
    dir: join(root, "logs"),
    stdout: false
  });
  const monitor = new SystemMonitor({ db, projectRoot: root, logger: logger.logger });

  return {
    root,
    db,
    monitor,
    close() {
      monitor.stop();
      db.close();
      logger.close();
    }
  };
}
