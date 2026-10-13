import { describe, expect, it } from "vitest";

import {
  applyExpiry,
  buildWouldWrite,
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
      parseLinkLine(started("job-1-ab12", "5")),
      parseLinkLine(settled("job-1-ab12", "5", 0)),
    ];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome).toMatchObject({
      kind: "settled",
      job_id: "job-1-ab12",
      task_id: "5",
      exitCode: 0,
      status: "completed",
    });
    expect(typeof outcome.task_id).toBe("string");
    expect(typeof (outcome as { exitCode: unknown }).exitCode).toBe("number");
  });

  it("yields nothing for lines without task_id", () => {
    const lines = [
      parseLinkLine(started("job-2-ab12")),
      parseLinkLine(settled("job-2-ab12", undefined, 0)),
    ];
    expect(pairLinkEvents(lines, NOW)).toEqual([]);
    expect(getPendingStarts(lines, NOW)).toEqual([]);
  });

  it("marks malformed JSON as malformed without throwing, and counts it", () => {
    const raw = [
      started("job-3-c001", "1"),
      "not json {{{",
      settled("job-3-c001", "1", 0),
    ];
    const parsed = raw.map((line) => parseLinkLine(line));
    expect(parsed[1]).toEqual({ malformed: true });
    expect(() => raw.map((line) => parseLinkLine(line))).not.toThrow();
    const malformedCount = parsed.filter(isMalformedLine).length;
    expect(malformedCount).toBe(1);
  });

  it("flags duplicate started with one duplicate-start flag", () => {
    const lines = [
      parseLinkLine(started("job-2-c3d4", "2")),
      parseLinkLine(started("job-2-c3d4", "2")),
    ];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "flag",
      reason: "duplicate-start",
      job_id: "job-2-c3d4",
    });
  });

  it("flags settled with no started as orphan-settle", () => {
    const lines = [parseLinkLine(settled("job-3-ef01", "3", 1, "error"))];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "flag",
      reason: "orphan-settle",
      job_id: "job-3-ef01",
    });
  });

  it("passes exitCode null (spawn_error shape) through as null", () => {
    const lines = [
      parseLinkLine(started("job-4-001a", "4")),
      parseLinkLine(settled("job-4-001a", "4", null, "spawn_error")),
    ];
    const outcomes = pairLinkEvents(lines, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "settled",
      job_id: "job-4-001a",
      task_id: "4",
      exitCode: null,
      status: "spawn_error",
    });
  });

  it("leaves started-without-settle pending and exposes it for expiry (Task 3)", () => {
    const lines = [parseLinkLine(started("job-7-00b7", "7"))];
    expect(pairLinkEvents(lines, NOW)).toEqual([]);
    const pending = getPendingStarts(lines, NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ job_id: "job-7-00b7", task_id: "7" });

    const combined = pairLinkEventsWithPending(lines, NOW);
    expect(combined.outcomes).toEqual([]);
    expect(combined.pending).toHaveLength(1);
    expect(combined.malformedCount).toBe(0);
  });
});

describe("job link watcher expiry + would-write (Task 3)", () => {
  const HOUR_MS = 3600 * 1000;

  it("expires a 25 h old pending start as died-with-session", () => {
    const lastSeenTs = NOW - 25 * HOUR_MS;
    const outcomes = applyExpiry(
      [{ job_id: "job-old", task_id: "5", lastSeenTs }],
      NOW,
    );
    expect(outcomes).toEqual([
      { kind: "died-with-session", job_id: "job-old", task_id: "5", lastSeenTs },
    ]);
  });

  it("keeps a 1 h old pending start pending (no outcome)", () => {
    const pending = [
      { job_id: "job-fresh", task_id: "5", lastSeenTs: NOW - HOUR_MS },
    ];
    expect(applyExpiry(pending, NOW)).toEqual([]);
  });

  it("keeps a start exactly at the 24 h boundary pending (expiry is strictly past age)", () => {
    const pending = [
      { job_id: "job-edge", task_id: "5", lastSeenTs: NOW - 24 * HOUR_MS },
    ];
    expect(applyExpiry(pending, NOW)).toEqual([]);
  });

  it("honours an explicit maxAgeMs", () => {
    const pending = [
      { job_id: "job-x", task_id: "5", lastSeenTs: NOW - 2 * HOUR_MS },
    ];
    expect(applyExpiry(pending, NOW, HOUR_MS)).toHaveLength(1);
    expect(applyExpiry(pending, NOW, 3 * HOUR_MS)).toEqual([]);
  });

  it("never deletes information: applyExpiry does not mutate its input", () => {
    const pending = [
      { job_id: "job-old", task_id: "5", lastSeenTs: NOW - 25 * HOUR_MS },
      { job_id: "job-fresh", task_id: "6", lastSeenTs: NOW - HOUR_MS },
    ];
    const snapshot = JSON.parse(JSON.stringify(pending));
    applyExpiry(pending, NOW);
    expect(pending).toEqual(snapshot);
  });

  it("late settle pairs normally and additionally flags late-settle", () => {
    const lines = [
      parseLinkLine(started("job-9-1a2b", "9", NOW - 25 * HOUR_MS)),
      parseLinkLine(settled("job-9-1a2b", "9", 0, "completed", NOW)),
    ];
    expect(pairLinkEvents(lines, NOW)).toEqual([
      {
        kind: "settled",
        job_id: "job-9-1a2b",
        task_id: "9",
        exitCode: 0,
        status: "completed",
        ts: NOW,
      },
      { kind: "flag", reason: "late-settle", job_id: "job-9-1a2b", task_id: "9" },
    ]);
  });

  it("fresh settle pairs with no late-settle flag", () => {
    const lines = [
      parseLinkLine(started("job-9-3c4d", "9", NOW - HOUR_MS)),
      parseLinkLine(settled("job-9-3c4d", "9", 0, "completed", NOW)),
    ];
    expect(pairLinkEvents(lines, NOW)).toHaveLength(1);
  });

  it("buildWouldWrite yields the exact WouldWrite payload for an existing task", () => {
    const seen: string[] = [];
    const payload = buildWouldWrite(
      {
        kind: "settled",
        job_id: "job-1-ab12",
        task_id: "5",
        exitCode: 0,
        status: "completed",
        ts: NOW,
      },
      (id) => {
        seen.push(id);
        return true;
      },
    );
    expect(payload).toEqual({
      task_id: "5",
      metadata_key: "asyncBashOutcomes",
      note: { job_id: "job-1-ab12", exitCode: 0, status: "completed", ts: NOW },
    });
    expect(seen).toEqual(["5"]);
  });

  it("buildWouldWrite flags unknown-task for a missing task (never a payload)", () => {
    const payload = buildWouldWrite(
      {
        kind: "settled",
        job_id: "job-8-beef",
        task_id: "404",
        exitCode: 0,
        status: "completed",
        ts: NOW,
      },
      () => false,
    );
    expect(payload).toEqual({ flag: "unknown-task" });
  });

  it("buildWouldWrite yields null for non-settled outcomes without consulting the store", () => {
    let calls = 0;
    const taskExists = () => {
      calls++;
      return true;
    };
    expect(
      buildWouldWrite(
        { kind: "died-with-session", job_id: "j", task_id: "5", lastSeenTs: NOW },
        taskExists,
      ),
    ).toBeNull();
    expect(
      buildWouldWrite(
        { kind: "flag", reason: "orphan-settle", job_id: "j", task_id: "5" },
        taskExists,
      ),
    ).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("job link watcher job_id conformance (hardening)", () => {
  it("rejects the forged non-conforming ID as malformed", () => {
    const forged =
      '{"event":"started","job_id":"job-3-818148","command":"sleep 25","task_id":"3","ts":1791923955813}';
    expect(parseLinkLine(forged)).toEqual({ malformed: true });
  });

  it("rejects a 3-hex suffix as malformed", () => {
    const line = JSON.stringify({ event: "started", job_id: "job-1-abc", task_id: "1", ts: NOW });
    expect(parseLinkLine(line)).toEqual({ malformed: true });
  });

  it("rejects a 5-hex suffix as malformed", () => {
    const line = JSON.stringify({ event: "started", job_id: "job-1-abcde", task_id: "1", ts: NOW });
    expect(parseLinkLine(line)).toEqual({ malformed: true });
  });

  it("rejects uppercase hex as malformed", () => {
    const line = JSON.stringify({ event: "started", job_id: "job-1-AB12", task_id: "1", ts: NOW });
    expect(parseLinkLine(line)).toEqual({ malformed: true });
  });

  it("rejects a missing job_id as malformed", () => {
    const line = JSON.stringify({ event: "started", task_id: "1", ts: NOW });
    expect(parseLinkLine(line)).toEqual({ malformed: true });
  });

  it("rejects a non-string job_id as malformed", () => {
    const line = JSON.stringify({ event: "started", job_id: 123, task_id: "1", ts: NOW });
    expect(parseLinkLine(line)).toEqual({ malformed: true });
  });

  it("rejects a forged settled line as malformed", () => {
    const line = JSON.stringify({
      event: "settled",
      job_id: "job-3-818148",
      task_id: "3",
      exitCode: 0,
      status: "completed",
      ts: NOW,
    });
    expect(parseLinkLine(line)).toEqual({ malformed: true });
  });

  it("counts a forged pair as malformed with no outcome (no false pairing)", () => {
    const forgedStart =
      '{"event":"started","job_id":"job-3-818148","command":"sleep 25","task_id":"3","ts":1791923955813}';
    const forgedSettle = JSON.stringify({
      event: "settled",
      job_id: "job-3-818148",
      task_id: "3",
      exitCode: 0,
      status: "completed",
      ts: 1791923985813,
    });
    const parsed = [parseLinkLine(forgedStart), parseLinkLine(forgedSettle)];
    expect(parsed).toEqual([{ malformed: true }, { malformed: true }]);
    const combined = pairLinkEventsWithPending(parsed, NOW);
    expect(combined.outcomes).toEqual([]);
    expect(combined.pending).toEqual([]);
    expect(combined.malformedCount).toBe(2);
  });

  it("accepts a conforming job_id", () => {
    const line = JSON.stringify({ event: "started", job_id: "job-3-a1b2", task_id: "3", ts: NOW });
    expect(parseLinkLine(line)).toMatchObject({ event: "started", job_id: "job-3-a1b2" });
  });
});
