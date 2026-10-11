/**
 * Tier 2 fork fixes:
 * - Issue #70: TaskGet/TaskUpdate report unknown IDs as tool errors, not success text.
 * - Issue #71: TaskUpdate warns when moving to in_progress/completed with open blockers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { mockCtx, mockPi } from "./helpers/mock-pi.js";

vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({}),
  loadTasksConfig: () => ({}),
  saveTasksConfig: () => {},
}));

beforeEach(() => {
  process.env.PI_TASKS = "off";
});
afterEach(() => {
  delete process.env.PI_TASKS;
  vi.restoreAllMocks();
});

describe("TaskStore open-blocker warnings (#71)", () => {
  it("warns when moving to in_progress with an open blocker", () => {
    const store = new TaskStore();
    store.create("Blocker", "d");
    store.create("Blocked", "d");
    store.update("1", { addBlocks: ["2"] });

    const { task, warnings } = store.update("2", { status: "in_progress" });
    expect(task?.status).toBe("in_progress");
    expect(warnings).toContain("#2 blocked by #1");
  });

  it("warns when moving to completed with an open blocker", () => {
    const store = new TaskStore();
    store.create("Blocker", "d");
    store.create("Blocked", "d");
    store.update("1", { addBlocks: ["2"] });

    const { warnings } = store.update("2", { status: "completed" });
    expect(warnings).toContain("#2 blocked by #1");
  });

  it("does not warn for pending or when blockers are completed", () => {
    const store = new TaskStore();
    store.create("Blocker", "d");
    store.create("Blocked", "d");
    store.update("1", { addBlocks: ["2"] });

    expect(store.update("2", { status: "pending" }).warnings).toEqual([]);

    store.update("1", { status: "completed" });
    expect(store.update("2", { status: "in_progress" }).warnings).toEqual([]);
  });

  it("does not warn when there are no blockers", () => {
    const store = new TaskStore();
    store.create("Solo", "d");
    expect(store.update("1", { status: "in_progress" }).warnings).toEqual([]);
  });
});

describe("TaskGet/TaskUpdate unknown IDs (#70)", () => {
  function setup() {
    const mock = mockPi();
    initExtension(mock.pi as any);
    return mock;
  }

  it("TaskGet throws for an unknown ID", async () => {
    const mock = setup();
    await expect(mock.executeTool("TaskGet", { taskId: "999" }, mockCtx())).rejects.toThrow(
      "Task #999 not found",
    );
  });

  it("TaskUpdate throws for an unknown ID", async () => {
    const mock = setup();
    await expect(
      mock.executeTool("TaskUpdate", { taskId: "999", status: "completed" }, mockCtx()),
    ).rejects.toThrow("Task #999 not found");
  });

  it("TaskUpdate on a deleted task throws", async () => {
    const mock = setup();
    const ctx = mockCtx();
    await mock.executeTool("TaskCreate", { subject: "Temp", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "deleted" }, ctx);
    await expect(
      mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" }, ctx),
    ).rejects.toThrow("Task #1 not found");
  });

  it("TaskUpdate surfaces the open-blocker warning in the tool response", async () => {
    const mock = setup();
    const ctx = mockCtx();
    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "d" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", addBlocks: ["2"] }, ctx);

    const result = await mock.executeTool(
      "TaskUpdate",
      { taskId: "2", status: "in_progress" },
      ctx,
    );
    const text = result.content[0].text as string;
    expect(text).toContain("warning");
    expect(text).toContain("#2 blocked by #1");
  });
});
