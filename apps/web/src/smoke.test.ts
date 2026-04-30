import { describe, expect, it } from "vitest";
import { columnsForSmokeTest } from "./smoke";

describe("web smoke", () => {
  it("keeps the board columns stable", () => {
    expect(columnsForSmokeTest()).toEqual([
      "todo",
      "queued",
      "running",
      "human_review",
      "finalizing",
      "done",
      "failed"
    ]);
  });
});
