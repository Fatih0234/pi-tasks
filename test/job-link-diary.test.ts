import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkJobLinks } from "../src/job-link-check.js";
import {
  appendDiary,
  diaryPathFor,
  readNewLines,
} from "../src/job-link-diary.js";
import type { LinkOutcome } from "../src/job-link-watcher.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "job-link-diary-test-"));
}

const SETTLED: LinkOutcome = {
  kind: "settled",
  job_id: "job-1-ab12",
  task_id: "5",
  exitCode: 0,
  status: "completed",
  ts: 1_760_000_000_000,
};

const FLAG: LinkOutcome = {
  kind: "flag",
  reason: "orphan-settle",
  job_id: "job-3-ef01",
  task_id: "3",
};

describe("job-link diary (fs boundary)", () => {
  it("derives the diary path as a sibling of the log", () => {
    const logPath = join(makeTmpDir(), "event.log");
    const diary = diaryPathFor(logPath);
    expect(diary).toBe(`${logPath}.watcher-diary.jsonl`);
    expect(dirname(diary)).toBe(dirname(logPath));
  });

  it("returns only bytes after the stored offset and persists the new offset", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const offsetPath = join(dir, "event.log.offset");
    const line1 = JSON.stringify({ event: "started", job_id: "j1", task_id: "1", ts: 1 });
    const line2 = JSON.stringify({ event: "settled", job_id: "j1", task_id: "1", ts: 2 });
    writeFileSync(logPath, `${line1}\n${line2}\n`);
    // Simulate a prior read that consumed exactly the first line.
    writeFileSync(offsetPath, `${Buffer.byteLength(`${line1}\n`)}\n`);

    const result = readNewLines(logPath, offsetPath);
    expect(result.lines).toEqual([line2]);
    expect(result.reset).toBe(false);
    expect(result.skippedCount).toBe(0);
    const size = Buffer.byteLength(`${line1}\n${line2}\n`);
    expect(result.nextOffset).toBe(size);
    // Offset is persisted for the next call.
    expect(readFileSync(offsetPath, "utf8").trim()).toBe(`${size}`);
  });

  it("returns zero lines on a second call with no growth", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const offsetPath = join(dir, "event.log.offset");
    writeFileSync(logPath, `${JSON.stringify({ event: "started", job_id: "j1", ts: 1 })}\n`);
    const first = readNewLines(logPath, offsetPath);
    expect(first.lines).toHaveLength(1);
    const second = readNewLines(logPath, offsetPath);
    expect(second.lines).toEqual([]);
    expect(second.nextOffset).toBe(first.nextOffset);
    expect(second.reset).toBe(false);
  });

  it("re-baselines from zero with reset:true when the offset is beyond EOF (rotation)", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const offsetPath = join(dir, "event.log.offset");
    const line = JSON.stringify({ event: "started", job_id: "j1", ts: 1 });
    writeFileSync(logPath, `${line}\n`);
    // Stale offset from before rotation/truncation.
    writeFileSync(offsetPath, "999999999\n");

    const result = readNewLines(logPath, offsetPath);
    expect(result.reset).toBe(true);
    expect(result.lines).toEqual([line]);
    expect(result.nextOffset).toBe(Buffer.byteLength(`${line}\n`));
  });

  it("appends one JSON object per line with diary_ts, outcome, and would_write", () => {
    const dir = makeTmpDir();
    const diaryPath = join(dir, "event.log.watcher-diary.jsonl");
    appendDiary(diaryPath, [SETTLED, FLAG]);

    const raw = readFileSync(diaryPath, "utf8").trimEnd().split("\n");
    expect(raw).toHaveLength(2);
    const [settledEntry, flagEntry] = raw.map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(typeof settledEntry.diary_ts).toBe("number");
    expect(settledEntry.outcome).toEqual(SETTLED);
    expect(settledEntry.would_write).toEqual({
      task_id: "5",
      metadata_key: "asyncBashOutcomes",
      note: { job_id: "job-1-ab12", exitCode: 0, status: "completed", ts: 1_760_000_000_000 },
    });

    expect(typeof flagEntry.diary_ts).toBe("number");
    expect(flagEntry.outcome).toEqual(FLAG);
    expect(flagEntry.would_write).toBeNull();
  });

  it("skips a 10 MB single line and counts it without returning it", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const offsetPath = join(dir, "event.log.offset");
    const line1 = JSON.stringify({ event: "started", job_id: "j1", ts: 1 });
    const huge = `x`.repeat(10 * 1024 * 1024);
    const line3 = JSON.stringify({ event: "settled", job_id: "j1", ts: 2 });
    writeFileSync(logPath, `${line1}\n${huge}\n${line3}\n`);

    const result = readNewLines(logPath, offsetPath);
    expect(result.lines).toEqual([line1, line3]);
    expect(result.skippedCount).toBe(1);
    expect(result.nextOffset).toBe(Buffer.byteLength(`${line1}\n${huge}\n${line3}\n`));
    for (const line of result.lines) {
      expect(line.length).toBeLessThan(1024 * 1024);
    }
  });

  it("never throws on fs failures (missing log, unwritable diary)", () => {
    const dir = makeTmpDir();
    expect(() =>
      readNewLines(join(dir, "does-not-exist.log"), join(dir, "o.offset")),
    ).not.toThrow();
    expect(() =>
      appendDiary(join(dir, "no-such-dir", "d.jsonl"), [SETTLED]),
    ).not.toThrow();
  });
});

describe("job-link turn_start wiring (Task 4 dry-run)", () => {
  const ENV_KEY = "PI_ASYNC_BASH_EVENT_LOG";
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  function withEnv(value: string | undefined, fn: () => void): void {
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    try {
      fn();
    } finally {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
    }
  }

  it("appends exactly one diary entry with the correct would_write for a fresh pair", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const now = Date.now();
    const startedLine = JSON.stringify({
      event: "started",
      job_id: "job-1-ab12",
      task_id: "5",
      ts: now - 1000,
    });
    const settledLine = JSON.stringify({
      event: "settled",
      job_id: "job-1-ab12",
      task_id: "5",
      exitCode: 0,
      status: "completed",
      ts: now,
    });
    writeFileSync(logPath, `${startedLine}\n${settledLine}\n`);
    const fakeStore = {
      get: (id: string) => (id === "5" ? { id: "5" } : undefined),
    };
    withEnv(logPath, () => {
      checkJobLinks(fakeStore, { now });
    });

    const diaryPath = diaryPathFor(logPath);
    const raw = readFileSync(diaryPath, "utf8").trimEnd().split("\n");
    expect(raw).toHaveLength(1);
    const entry = JSON.parse(raw[0]) as Record<string, unknown>;
    expect(entry.outcome).toEqual({
      kind: "settled",
      job_id: "job-1-ab12",
      task_id: "5",
      exitCode: 0,
      status: "completed",
      ts: now,
    });
    expect(entry.would_write).toEqual({
      task_id: "5",
      metadata_key: "asyncBashOutcomes",
      note: { job_id: "job-1-ab12", exitCode: 0, status: "completed", ts: now },
    });
  });

  it("does nothing and creates no files when the env var is unset", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const now = Date.now();
    writeFileSync(
      logPath,
      `${JSON.stringify({ event: "started", job_id: "j1", task_id: "1", ts: now - 1000 })}\n`,
    );
    const diaryPath = diaryPathFor(logPath);
    const offsetPath = `${logPath}.offset`;
    const fakeStore = { get: (_id: string) => ({ id: _id }) };
    withEnv(undefined, () => {
      expect(() => checkJobLinks(fakeStore, { now })).not.toThrow();
    });
    expect(existsSync(diaryPath)).toBe(false);
    expect(existsSync(offsetPath)).toBe(false);
  });

  it("swallows a throwing store and still writes the diary", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const now = Date.now();
    const startedLine = JSON.stringify({
      event: "started",
      job_id: "job-9-beef",
      task_id: "9",
      ts: now - 1000,
    });
    const settledLine = JSON.stringify({
      event: "settled",
      job_id: "job-9-beef",
      task_id: "9",
      exitCode: 0,
      status: "completed",
      ts: now,
    });
    writeFileSync(logPath, `${startedLine}\n${settledLine}\n`);
    const throwingStore = {
      get: (_id: string): unknown => {
        throw new Error("boom");
      },
    };
    withEnv(logPath, () => {
      expect(() => checkJobLinks(throwingStore, { now })).not.toThrow();
    });
    const diaryPath = diaryPathFor(logPath);
    const raw = readFileSync(diaryPath, "utf8").trimEnd().split("\n");
    expect(raw).toHaveLength(1);
    const entry = JSON.parse(raw[0]) as Record<string, unknown>;
    expect(entry.outcome).toEqual({
      kind: "flag",
      reason: "unknown-task",
      job_id: "job-9-beef",
      task_id: "9",
    });
    expect(entry.would_write).toBeNull();
  });
});

describe("job-link pending persistence across turns (pending fix)", () => {
  const PENDING_SUFFIX = ".pending.json";
  const HOUR_MS = 3600 * 1000;

  it("(a) started in check N + settled in check N+1 pairs into ONE settled outcome, no orphan flag", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const diaryPath = diaryPathFor(logPath);
    const now1 = 1_760_000_000_000;
    const now2 = now1 + 5_000;
    const startedLine = JSON.stringify({
      event: "started",
      job_id: "job-10-c050",
      task_id: "smoke-1",
      ts: now1,
    });
    const settledLine = JSON.stringify({
      event: "settled",
      job_id: "job-10-c050",
      task_id: "smoke-1",
      exitCode: 0,
      status: "completed",
      ts: now2,
    });
    writeFileSync(logPath, `${startedLine}\n`);
    const store = {
      get: (id: string) => (id === "smoke-1" ? { id } : undefined),
    };
    // Turn N: only the start is visible.
    checkJobLinks(store, { logPath, now: now1 });
    // Turn N+1: the settle arrives (fresh module state = second call relies on disk).
    writeFileSync(logPath, `${startedLine}\n${settledLine}\n`);
    checkJobLinks(store, { logPath, now: now2 });

    const raw = readFileSync(diaryPath, "utf8").trimEnd().split("\n");
    expect(raw).toHaveLength(1);
    const entry = JSON.parse(raw[0]) as {
      outcome: LinkOutcome;
    };
    expect(entry.outcome).toMatchObject({
      kind: "settled",
      job_id: "job-10-c050",
      task_id: "smoke-1",
    });
    // No orphan flag anywhere in the diary.
    for (const line of raw) {
      const e = JSON.parse(line) as { outcome: LinkOutcome };
      if (e.outcome.kind === "flag") {
        expect(e.outcome.reason).not.toBe("orphan-settle");
      }
    }
  });

  it("(b) pending survives a corrupt sidecar (fresh start + counted event)", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const pendingPath = `${logPath}${PENDING_SUFFIX}`;
    const diaryPath = diaryPathFor(logPath);
    const now = 1_760_000_000_000;
    // Corrupt sidecar: invalid JSON.
    writeFileSync(pendingPath, "not json {{{\n");
    const startedLine = JSON.stringify({
      event: "started",
      job_id: "job-11-beef",
      task_id: "5",
      ts: now - 1000,
    });
    const settledLine = JSON.stringify({
      event: "settled",
      job_id: "job-11-beef",
      task_id: "5",
      exitCode: 0,
      status: "completed",
      ts: now,
    });
    writeFileSync(logPath, `${startedLine}\n${settledLine}\n`);
    const store = {
      get: (id: string) => (id === "5" ? { id } : undefined),
    };
    expect(() => checkJobLinks(store, { logPath, now })).not.toThrow();

    const raw = readFileSync(diaryPath, "utf8").trimEnd().split("\n");
    const outcomes = raw.map(
      (l) => (JSON.parse(l) as { outcome: LinkOutcome }).outcome,
    );
    // Corruption is counted in the diary...
    expect(
      outcomes.some(
        (o) => o.kind === "flag" && o.reason === "pending-corrupt",
      ),
    ).toBe(true);
    // ...and fresh pairing still works.
    expect(
      outcomes.some(
        (o) =>
          o.kind === "settled" &&
          o.job_id === "job-11-beef" &&
          o.task_id === "5",
      ),
    ).toBe(true);
    // Sidecar is healed to valid JSON.
    const healed = JSON.parse(readFileSync(pendingPath, "utf8")) as unknown;
    expect(Array.isArray(healed)).toBe(true);
  });

  it("(c) expiry still fires for genuinely old pendings loaded from disk", () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "event.log");
    const pendingPath = `${logPath}${PENDING_SUFFIX}`;
    const diaryPath = diaryPathFor(logPath);
    const now = 1_760_000_000_000;
    const oldTs = now - 25 * HOUR_MS;
    writeFileSync(
      pendingPath,
      `${JSON.stringify([{ job_id: "job-99-aaaa", task_id: "7", lastSeenTs: oldTs }])}\n`,
    );
    // No new log growth: expiry must fire from disk alone.
    writeFileSync(logPath, "");
    const store = { get: (_id: string) => undefined };
    checkJobLinks(store, { logPath, now });

    expect(existsSync(diaryPath)).toBe(true);
    const raw = readFileSync(diaryPath, "utf8").trimEnd().split("\n");
    const outcomes = raw.map(
      (l) => (JSON.parse(l) as { outcome: LinkOutcome }).outcome,
    );
    expect(outcomes).toContainEqual({
      kind: "died-with-session",
      job_id: "job-99-aaaa",
      task_id: "7",
      lastSeenTs: oldTs,
    });
  });
});
