/**
 * Dry-run job-link check for the `turn_start` hook (pilot).
 *
 * fs + store boundary around the pure matcher (`job-link-watcher.ts`)
 * and the diary tail (`job-link-diary.ts`). Skipped entirely when
 * `PI_ASYNC_BASH_EVENT_LOG` is unset. Read-only against the task store
 * (`get` per `task_id`); never writes to the store and never touches
 * reminder state. Never throws: every failure degrades to an empty
 * result or a dropped write so the hook never breaks the turn.
 */

import {
  appendDiary,
  diaryPathFor,
  readNewLines,
} from "./job-link-diary.js";
import {
  applyExpiry,
  buildWouldWrite,
  type LinkOutcome,
  pairLinkEventsWithPending,
  parseLinkLine,
} from "./job-link-watcher.js";

/** Minimal read-only surface `checkJobLinks` needs. `TaskStore` satisfies this. */
export interface CheckJobLinksStore {
  get(id: string): unknown;
}

export interface CheckJobLinksOptions {
  /** Override for `process.env.PI_ASYNC_BASH_EVENT_LOG` (tests). */
  logPath?: string;
  /** Clock override (tests). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * One dry-run pass: read new log lines past the stored offset, parse,
 * pair, expire, check task existence, append diary entries.
 *
 * Offset convention: sibling `<log>.offset` (Task 2 suggestion, adopted).
 * Diary path: `diaryPathFor(logPath)` (`<log>.watcher-diary.jsonl`).
 *
 * Never throws.
 */
export function checkJobLinks(
  store: CheckJobLinksStore,
  opts?: CheckJobLinksOptions,
): void {
  try {
    const logPath = opts?.logPath ?? process.env.PI_ASYNC_BASH_EVENT_LOG;
    if (!logPath) return;
    const now = opts?.now ?? Date.now();
    const offsetPath = `${logPath}.offset`;
    const diaryPath = diaryPathFor(logPath);

    const { lines } = readNewLines(logPath, offsetPath);
    if (lines.length === 0) return;

    const parsed = lines.map(parseLinkLine);
    const { outcomes, pending } = pairLinkEventsWithPending(parsed, now);
    const expired = applyExpiry(pending, now);
    const all: LinkOutcome[] = [...outcomes, ...expired];
    if (all.length === 0) return;

    const toRecord: LinkOutcome[] = [];
    for (const outcome of all) {
      if (outcome.kind !== "settled") {
        toRecord.push(outcome);
        continue;
      }
      let result: ReturnType<typeof buildWouldWrite>;
      try {
        result = buildWouldWrite(outcome, (id) => store.get(id) !== undefined);
      } catch {
        // Throwing store is swallowed: still diary the outcome as a flag,
        // never a write.
        toRecord.push({
          kind: "flag",
          reason: "unknown-task",
          job_id: outcome.job_id,
          task_id: outcome.task_id,
        });
        continue;
      }
      // `buildWouldWrite` may return null for non-settled outcomes:
      // null-check before any `"flag" in result` narrowing.
      if (result === null) {
        toRecord.push(outcome);
        continue;
      }
      if ("flag" in result) {
        toRecord.push({
          kind: "flag",
          reason: "unknown-task",
          job_id: outcome.job_id,
          task_id: outcome.task_id,
        });
        continue;
      }
      toRecord.push(outcome);
    }

    if (toRecord.length === 0) return;
    appendDiary(diaryPath, toRecord);
  } catch {
    // The hook never breaks the turn.
  }
}
