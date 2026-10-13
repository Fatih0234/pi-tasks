/**
 * Pure link-event matching for the job-link watcher (pilot dry-run).
 *
 * Parses raw async-bash event-log lines and pairs `started`/`settled`
 * events by exact `job_id` equality. No I/O, no task-store access, no
 * clock reads — the clock is injected as `now` for forward compatibility
 * with Task 3 (expiry), which consumes the pending starts exposed here.
 *
 * Matching rules:
 * - Pairing key is the full `job_id` string (`===`, no prefix matching).
 * - `task_id` equality is verbatim `===` wherever it is compared.
 * - Lines without `task_id` yield nothing: they are neither paired nor
 *   tracked as pending, and never produce flags.
 * - Malformed lines are skipped and counted, never thrown.
 * - `started` without `settled` stays pending; `applyExpiry` (Task 3)
 *   emits `died-with-session` for pending starts older than
 *   `DEFAULT_MAX_AGE_MS`, and a `settled` that pairs with such a stale
 *   start additionally yields a `late-settle` flag. Expiry only emits
 *   outcomes the diary records — it never deletes information.
 * - `unknown-task` remains reserved for the Task 4 task-existence check
 *   (`buildWouldWrite`); the matcher itself never emits it.
 */

import type { WouldWrite } from "./job-link-diary.js";

/** A well-formed `started` log event. */
export interface StartedLinkLine {
  event: "started";
  job_id: string;
  task_id?: string;
  ts: number;
  command?: string;
}

/** A well-formed `settled` log event. */
export interface SettledLinkLine {
  event: "settled";
  job_id: string;
  task_id?: string;
  ts: number;
  status?: string;
  exitCode?: number | null;
  command?: string;
}

/** A well-formed parsed log line. */
export type LinkLine = StartedLinkLine | SettledLinkLine;

/** Marker for a raw line that failed to parse. Counted, never thrown. */
export interface MalformedLine {
  malformed: true;
}

/** Output of {@link parseLinkLine}. */
export type ParsedLinkLine = LinkLine | MalformedLine;

/** A `started` event still waiting for its `settled` mate. Consumed by Task 3. */
export interface PendingStart {
  job_id: string;
  task_id: string | undefined;
  lastSeenTs: number;
}

/**
 * Default orphan horizon: a pending start older than this (relative to
 * the injected `now`) counts as expired. Shared by `applyExpiry` and
 * the late-settle detection in pairing so both apply the same rule.
 */
export const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000;

/** Marker returned by {@link buildWouldWrite} when the outcome's task does
 *  not exist. The caller must record a flag, never a write. */
export interface UnknownTaskFlag {
  flag: "unknown-task";
}

export type LinkOutcome =
  | {
      kind: "settled";
      job_id: string;
      task_id: string;
      exitCode: number | null;
      status: string;
      ts: number;
    }
  | {
      kind: "died-with-session";
      job_id: string;
      task_id: string | undefined;
      lastSeenTs: number;
    }
  | {
      kind: "flag";
      reason: "duplicate-start" | "orphan-settle" | "unknown-task" | "late-settle";
      job_id: string;
      task_id?: string;
    };

/** Combined pairing result for Task 3: outcomes plus still-pending starts. */
export interface PairResult {
  outcomes: LinkOutcome[];
  pending: PendingStart[];
  malformedCount: number;
}

/** Type guard for counting malformed parse results. */
export function isMalformedLine(value: ParsedLinkLine): value is MalformedLine {
  return (value as MalformedLine).malformed === true;
}

/**
 * Parse one raw log line. Returns the link line, or `{ malformed: true }`
 * for bad JSON or a well-formed JSON value with a missing/invalid `event`,
 * `job_id`, or `ts`. Never throws.
 */
export function parseLinkLine(line: string): ParsedLinkLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { malformed: true };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { malformed: true };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.event !== "started" && obj.event !== "settled") {
    return { malformed: true };
  }
  if (typeof obj.job_id !== "string" || obj.job_id.length === 0) {
    return { malformed: true };
  }
  if (typeof obj.ts !== "number" || Number.isNaN(obj.ts)) {
    return { malformed: true };
  }
  if (obj.task_id !== undefined && typeof obj.task_id !== "string") {
    return { malformed: true };
  }
  if (
    obj.status !== undefined &&
    typeof obj.status !== "string"
  ) {
    return { malformed: true };
  }
  if (
    obj.exitCode !== undefined &&
    obj.exitCode !== null &&
    typeof obj.exitCode !== "number"
  ) {
    return { malformed: true };
  }
  if (obj.command !== undefined && typeof obj.command !== "string") {
    return { malformed: true };
  }

  if (obj.event === "started") {
    const started: StartedLinkLine = {
      event: "started",
      job_id: obj.job_id,
      ts: obj.ts,
    };
    if (typeof obj.task_id === "string") started.task_id = obj.task_id;
    if (typeof obj.command === "string") started.command = obj.command;
    return started;
  }

  const settled: SettledLinkLine = {
    event: "settled",
    job_id: obj.job_id,
    ts: obj.ts,
  };
  if (typeof obj.task_id === "string") settled.task_id = obj.task_id;
  if (typeof obj.status === "string") settled.status = obj.status;
  if (obj.exitCode === null || typeof obj.exitCode === "number") {
    settled.exitCode = obj.exitCode;
  }
  if (typeof obj.command === "string") settled.command = obj.command;
  return settled;
}

function processLines(
  lines: readonly ParsedLinkLine[],
  now: number = 0,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): { outcomes: LinkOutcome[]; pending: Map<string, PendingStart>; malformedCount: number } {
  const outcomes: LinkOutcome[] = [];
  const pending = new Map<string, PendingStart>();
  let malformedCount = 0;

  for (const line of lines) {
    if (isMalformedLine(line)) {
      malformedCount++;
      continue;
    }
    // Lines without task_id yield nothing: skip before any tracking.
    if (line.task_id === undefined) continue;

    if (line.event === "started") {
      const existing = pending.get(line.job_id);
      if (existing !== undefined) {
        outcomes.push({
          kind: "flag",
          reason: "duplicate-start",
          job_id: line.job_id,
          task_id: line.task_id,
        });
        // Keep the first start; refresh the last-seen timestamp.
        if (line.ts > existing.lastSeenTs) existing.lastSeenTs = line.ts;
        continue;
      }
      pending.set(line.job_id, {
        job_id: line.job_id,
        task_id: line.task_id,
        lastSeenTs: line.ts,
      });
      continue;
    }

    // Settled event: the outcome `task_id` is verbatim the settle line's
    // `task_id`. (Settle lines without `task_id` are skipped before
    // tracking, so pairing only ever sees settles that carry one.)
    const start = pending.get(line.job_id);
    if (start === undefined) {
      outcomes.push({
        kind: "flag",
        reason: "orphan-settle",
        job_id: line.job_id,
        task_id: line.task_id,
      });
      continue;
    }
    pending.delete(line.job_id);
    outcomes.push({
      kind: "settled",
      job_id: line.job_id,
      task_id: line.task_id,
      exitCode: line.exitCode ?? null,
      status: line.status ?? "unknown",
      ts: line.ts,
    });
    // Late settle: the start was already past the orphan horizon when
    // this batch was processed (it would have expired via applyExpiry
    // had its settle not arrived here). Pair normally, and additionally
    // flag it so the diary shows the job was declared dead first.
    if (now - start.lastSeenTs > maxAgeMs) {
      outcomes.push({
        kind: "flag",
        reason: "late-settle",
        job_id: line.job_id,
        task_id: line.task_id,
      });
    }
  }

  return { outcomes, pending, malformedCount };
}

/**
 * Pair parsed link lines into outcomes. `started` without `settled`
 * stays pending (no outcome; see {@link getPendingStarts} and
 * {@link applyExpiry}). Malformed entries are skipped. A `settled` that
 * pairs with a start already past `maxAgeMs` (relative to `now`) yields
 * its `settled` outcome plus a `late-settle` flag.
 */
export function pairLinkEvents(
  lines: readonly ParsedLinkLine[],
  now: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): LinkOutcome[] {
  return processLines(lines, now, maxAgeMs).outcomes;
}

/**
 * Recompute the currently pending starts (started-without-settle with
 * a `task_id`). Consumed by Task 3 expiry.
 */
export function getPendingStarts(
  lines: readonly ParsedLinkLine[],
  _now?: number,
): PendingStart[] {
  return [...processLines(lines).pending.values()];
}

/**
 * Single-pass pairing for Task 3: outcomes, pending starts, and the
 * count of skipped malformed entries. Late-settle detection uses the
 * same `now`/`maxAgeMs` rule as {@link pairLinkEvents}.
 */
export function pairLinkEventsWithPending(
  lines: readonly ParsedLinkLine[],
  now: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): PairResult {
  const { outcomes, pending, malformedCount } = processLines(lines, now, maxAgeMs);
  return { outcomes, pending: [...pending.values()], malformedCount };
}

/**
 * Emit `died-with-session` outcomes for pending starts older than
 * `maxAgeMs` (strictly past age: `now - lastSeenTs > maxAgeMs`),
 * defaulting to {@link DEFAULT_MAX_AGE_MS} (24 h). Fresh entries yield
 * nothing and stay pending.
 *
 * Expiry never deletes information: this function only emits outcomes
 * for the diary to record. It does not mutate `pending` — the caller
 * keeps whatever entries it still wants to pair against, so a `settled`
 * arriving after expiry still pairs normally (with a `late-settle`
 * flag from pairing).
 */
export function applyExpiry(
  pending: readonly PendingStart[],
  now: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): LinkOutcome[] {
  const outcomes: LinkOutcome[] = [];
  for (const start of pending) {
    if (now - start.lastSeenTs > maxAgeMs) {
      outcomes.push({
        kind: "died-with-session",
        job_id: start.job_id,
        task_id: start.task_id,
        lastSeenTs: start.lastSeenTs,
      });
    }
  }
  return outcomes;
}

/**
 * Build the dry-run write payload for one outcome. `settled` outcomes
 * for an existing task yield the exact `WouldWrite` payload (key
 * `asyncBashOutcomes`, note with job_id/exitCode/status/ts); `settled`
 * outcomes whose task is unknown yield `{ flag: "unknown-task" }` —
 * flagged, never written. Every other kind (`died-with-session`,
 * `flag`) yields null: there is nothing to write, so the store is not
 * consulted. `taskExists` exceptions propagate to the caller.
 */
export function buildWouldWrite(
  outcome: LinkOutcome,
  taskExists: (id: string) => boolean,
): WouldWrite | UnknownTaskFlag | null {
  if (outcome.kind !== "settled") return null;
  if (!taskExists(outcome.task_id)) return { flag: "unknown-task" };
  return {
    task_id: outcome.task_id,
    metadata_key: "asyncBashOutcomes",
    note: {
      job_id: outcome.job_id,
      exitCode: outcome.exitCode,
      status: outcome.status,
      ts: outcome.ts,
    },
  };
}
