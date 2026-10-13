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
 * - `started` without `settled` stays pending (expiry is Task 3).
 * - Task 1 never emits `died-with-session` (Task 3 expiry) or
 *   `unknown-task` (Task 4 task-existence check); both remain in the
 *   `LinkOutcome` union for those later tasks.
 */

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
      reason: "duplicate-start" | "orphan-settle" | "unknown-task";
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

    // Settled event: task_id resolves verbatim from the settle line,
    // falling back to the start line when the settle line omits it
    // (parse keeps that case well-formed for forward compatibility).
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
  }

  return { outcomes, pending, malformedCount };
}

/**
 * Pair parsed link lines into outcomes. `started` without `settled`
 * stays pending (no outcome; see {@link getPendingStarts}). Malformed
 * entries are skipped. `now` is accepted for signature compatibility
 * with Task 3 expiry and is unused here.
 */
export function pairLinkEvents(
  lines: readonly ParsedLinkLine[],
  now: number,
): LinkOutcome[] {
  void now;
  return processLines(lines).outcomes;
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
 * count of skipped malformed entries.
 */
export function pairLinkEventsWithPending(
  lines: readonly ParsedLinkLine[],
  now: number,
): PairResult {
  void now;
  const { outcomes, pending, malformedCount } = processLines(lines);
  return { outcomes, pending: [...pending.values()], malformedCount };
}
