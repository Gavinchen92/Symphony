import type { TaskStatus } from "@symphony/shared";

export function columnsForSmokeTest(): TaskStatus[] {
  return ["todo", "queued", "running", "human_review", "done", "failed"];
}

