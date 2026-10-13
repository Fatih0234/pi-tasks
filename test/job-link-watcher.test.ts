import { describe, expect, it } from "vitest";

import {
  getPendingStarts,
  isMalformedLine,
  pairLinkEvents,
  pairLinkEventsWithPending,
  parseLinkLine,
} from "../src/job-link-watcher.js";

const NOW = 1_760_000_000_000;

function started(
  job_id: string,
  task_id?: string,
  ts = NOW - 1000,
): string {
  return JSON.stringify(
    task_id === undefined
      ? { event: "started", job_id, ts }
      : { event: "started", job_id, task_id, ts },
  );
}

function settled(
  job_id: string,
  task_id?: string,
  exitCode: number | null = 0,
  status = "completed",
  ts = NOW,
): string {
  return JSON.stringify(
    task_id === undefined
      ? { event: "settled", job_id, exitCode, status, ts }
      : { event: "settled", job_id, task_id, exitCode, status, ts },
  );
}

describe("job link watcher (pure matcher)", () => {
  it("pairs started+settled with task_id into one settled outcome (verbatim task_id, numeric exitCode)", () => {
    const lines = [
      parseLinkLine(started("job-abc123", "5")),
      parseLinkLine(settled("job-abc123", "5", 0)),
    ];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome).toMatchObject({
      kind: "settled",
      job_id: "job-abc123",
      task_id: "5",
      exitCode: 0,
      status: "completed",
    });
    expect(typeof outcome.task_id).toBe("string");
    expect(typeof (outcome as { exitCode: unknown }).exitCode).toBe("number");
  });

  it("yields nothing for lines without task_id", () => {
    const lines = [
      parseLinkLine(started("job-notask")),
      parseLinkLine(settled("job-notask", undefined, 0)),
    ];
    expect(pairLinkEvents(lines, NOW)).toEqual([]);
    expect(getPendingStarts(lines, NOW)).toEqual([]);
  });

  it("marks malformed JSON as malformed without throwing, and counts it", () => {
    const raw = [
      started("job-1", "1"),
      "not json {{{",
      settled("job-1", "1", 0),
    ];
    const parsed = raw.map((line) => parseLinkLine(line));
    expect(parsed[1]).toEqual({ malformed: true });
    expect(() => raw.map((line) => parseLinkLine(line))).not.toThrow();
    const malformedCount = parsed.filter(isMalformedLine).length;
    expect(malformedCount).toBe(1);
  });

  it("flags duplicate started with one duplicate-start flag", () => {
    const lines = [
      parseLinkLine(started("job-dup", "2")),
      parseLinkLine(started("job-dup", "2")),
    ];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "flag",
      reason: "duplicate-start",
      job_id: "job-dup",
    });
  });

  it("flags settled with no started as orphan-settle", () => {
    const lines = [parseLinkLine(settled("job-ghost", "3", 1, "error"))];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "flag",
      reason: "orphan-settle",
      job_id: "job-ghost",
    });
  });

  it("passes exitCode null (spawn_error shape) through as null", () => {
    const lines = [
      parseLinkLine(started("job-spawn", "4")),
      parseLinkLine(settled("job-spawn", "4", null, "spawn_error")),
    ];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "settled",
      job_id: "job-spawn",
      task_id: "4",
      exitCode: null,
      status: "spawn_error",
    });
  });

  it("leaves started-without-settle pending and exposes it for expiry (Task 3)", () => {
    const lines = [parseLinkLine(started("job-hang", "7"))];
    expect(pairLinkEvents(lines, NOW)).toEqual([]);
    const pending = getPendingStarts(lines, NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ job_id: "job-hang", task_id: "7" });

    const combined = pairLinkEventsWithPending(lines, NOW);
    expect(combined.outcomes).toEqual([]);
    expect(combined.pending).toHaveLength(1);
    expect(combined.malformedCount).toBe(0);
  });
});
