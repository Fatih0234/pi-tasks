/**
 * Append-only watcher diary + new-bytes-only log tail (pilot dry-run).
 *
 * fs boundary around the pure matcher in `job-link-watcher.ts`. All
 * exported functions never throw: every `node:fs` sync call sits inside
 * try/catch so a diary/offset failure degrades to an empty result or a
 * dropped write instead of breaking the caller's turn.
 *
 * Contracts for Tasks 3-4 (do not rename these exports):
 * - `diaryPathFor`
 * - `readNewLines`
 * - `appendDiary`
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LinkOutcome, PendingStart } from "./job-link-watcher.js";

/** A single oversized line is skipped once its byte length exceeds this. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Bytes per `readSync` chunk while tailing. Small and fixed. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Byte value of `\n`. Lines are split on this byte; entries are UTF-8. */
const NEWLINE_BYTE = 10;

/** The dry-run payload a `settled` outcome *would* write to the store. */
export interface WouldWriteNote {
  job_id: string;
  exitCode: number | null;
  status: string;
  ts: number;
}

/** Dry-run write descriptor. `metadata_key` is always `"asyncBashOutcomes"`. */
export interface WouldWrite {
  task_id: string;
  metadata_key: "asyncBashOutcomes";
  note: WouldWriteNote;
}

/** One diary line: timestamp, the verbatim Task 1 outcome, and its payload. */
export interface DiaryEntry {
  diary_ts: number;
  outcome: LinkOutcome;
  would_write: WouldWrite | null;
}

/** Result of {@link readNewLines}. */
export interface ReadNewLinesResult {
  /** Complete lines (without terminators) after the stored offset. */
  lines: string[];
  /** Byte offset to persist / pass as the next call's stored offset. */
  nextOffset: number;
  /** True when the stored offset was beyond EOF and reading restarted at 0. */
  reset: boolean;
  /** Lines skipped for exceeding {@link MAX_LINE_BYTES}. */
  skippedCount: number;
}

/**
 * Derive the diary path for a log path: sibling `<log>.watcher-diary.jsonl`.
 * Pure string concat; never throws.
 */
export function diaryPathFor(logPath: string): string {
  return `${logPath}.watcher-diary.jsonl`;
}

/**
 * Derive the pending-sidecar path for a log path: sibling `<log>.pending.json`.
 * Same directory as the log, offset (`<log>.offset`), and diary. Pure string
 * concat; never throws. Chosen over `<log>.pending` to make the JSON format
 * explicit at a glance in tmp/ls output.
 */
export function pendingPathFor(logPath: string): string {
  return `${logPath}.pending.json`;
}

/** Result of {@link loadPendingStarts}. */
export interface LoadPendingResult {
  /** Validated pending starts (deduped by `job_id`, last wins). */
  pending: PendingStart[];
  /** True when the file existed but was unreadable or invalid (counted in diary). */
  corrupt: boolean;
}

function isValidPendingEntry(value: unknown): value is PendingStart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.job_id !== "string" || obj.job_id === "") return false;
  if (
    obj.task_id !== undefined &&
    typeof obj.task_id !== "string"
  ) {
    return false;
  }
  if (typeof obj.lastSeenTs !== "number" || Number.isNaN(obj.lastSeenTs)) {
    return false;
  }
  return true;
}

/**
 * Load pending starts from the sidecar. Missing file means no pendings yet
 * (`{ pending: [], corrupt: false }`). A file that exists but cannot be read,
 * parses to non-array JSON, or contains invalid entries yields `corrupt: true`
 * (caller diaries one `pending-corrupt` flag) with `pending` holding the valid
 * subset (possibly empty = fresh start). Tolerates the existing `PendingStart
 * { job_id, task_id, lastSeenTs }` shape; extra fields are ignored. Never throws.
 */
export function loadPendingStarts(pendingPath: string): LoadPendingResult {
  try {
    let raw: string;
    try {
      raw = readFileSync(pendingPath, "utf8");
    } catch {
      // Distinguish missing (first run, not corrupt) from unreadable (corrupt).
      try {
        statSync(pendingPath);
      } catch {
        return { pending: [], corrupt: false };
      }
      return { pending: [], corrupt: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { pending: [], corrupt: true };
    }
    if (!Array.isArray(parsed)) return { pending: [], corrupt: true };
    const byId = new Map<string, PendingStart>();
    let invalid = 0;
    for (const entry of parsed) {
      if (!isValidPendingEntry(entry)) {
        invalid++;
        continue;
      }
      byId.set(entry.job_id, {
        job_id: entry.job_id,
        task_id: entry.task_id,
        lastSeenTs: entry.lastSeenTs,
      });
    }
    return { pending: [...byId.values()], corrupt: invalid > 0 };
  } catch {
    return { pending: [], corrupt: true };
  }
}

/**
 * Persist pending starts to the sidecar (JSON array, trailing newline).
 * Overwrites the previous file, healing a corrupt one. Best effort; never throws.
 */
export function savePendingStarts(
  pendingPath: string,
  pending: readonly PendingStart[],
): void {
  try {
    try {
      mkdirSync(dirname(pendingPath), { recursive: true });
    } catch {
      // Best effort; the write below reports the real failure.
    }
    writeFileSync(pendingPath, `${JSON.stringify([...pending])}\n`, "utf8");
  } catch {
    // Sidecar persistence must never break the caller.
  }
}

/**
 * Derive the dry-run payload for one outcome. `settled` outcomes produce a
 * `WouldWrite`; every other kind (`died-with-session`, `flag`) yields null.
 * Task 3's `buildWouldWrite(outcome, taskExists)` supersedes this when the
 * task-existence check is wired (Task 4); until then this is what
 * {@link appendDiary} records.
 */
export function wouldWriteForOutcome(outcome: LinkOutcome): WouldWrite | null {
  if (outcome.kind !== "settled") return null;
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

/**
 * Append one JSON object per outcome to the diary (JSONL). A single
 * `Date.now()` timestamps the whole batch. Empty batches write nothing
 * (the file is not created). Never throws: failures are swallowed so the
 * caller (Task 4 hook) never breaks the turn.
 */
export function appendDiary(
  diaryPath: string,
  outcomes: readonly LinkOutcome[],
): void {
  try {
    if (outcomes.length === 0) return;
    const diaryTs = Date.now();
    const text = `${outcomes
      .map((outcome) =>
        JSON.stringify({
          diary_ts: diaryTs,
          outcome,
          would_write: wouldWriteForOutcome(outcome),
        } satisfies DiaryEntry),
      )
      .join("\n")}\n`;
    try {
      mkdirSync(dirname(diaryPath), { recursive: true });
    } catch {
      // Best effort; the append below reports the real failure.
    }
    appendFileSync(diaryPath, text, "utf8");
  } catch {
    // Diary is the only output and must never break the caller.
  }
}

/** Read the stored offset; missing/unparsable content means 0. */
function readStoredOffset(offsetPath: string): number {
  try {
    const raw = readFileSync(offsetPath, "utf8").trim();
    if (raw === "") return 0;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

/** Persist the offset for the next call. Best effort; never throws. */
function writeStoredOffset(offsetPath: string, offset: number): void {
  try {
    try {
      mkdirSync(dirname(offsetPath), { recursive: true });
    } catch {
      // Best effort; the write below reports the real failure.
    }
    writeFileSync(offsetPath, `${offset}\n`, "utf8");
  } catch {
    // Offset persistence must never break the caller.
  }
}

/**
 * Read only the bytes after the stored offset.
 *
 * - Missing offset file starts at 0. Missing log file returns no lines.
 * - Stored offset beyond EOF (rotation/truncation) re-baselines from 0
 *   with `reset: true`.
 * - Lines longer than {@link MAX_LINE_BYTES} are skipped and counted in
 *   `skippedCount` without ever buffering the whole line: the reader scans
 *   fixed-size chunks and discards oversized line bytes as it goes.
 * - A trailing partial line (no terminating `\n` yet) is held, not
 *   returned: `nextOffset` stops at its first byte so the next call sees
 *   it whole. An oversized partial is likewise held uncounted until its
 *   terminator arrives.
 * - The new offset is persisted to `offsetPath` on every successful log
 *   read (including empty growth), so a second call with no growth
 *   returns zero lines.
 *
 * Never throws.
 */
export function readNewLines(
  logPath: string,
  offsetPath: string,
): ReadNewLinesResult {
  try {
    return readNewLinesInner(logPath, offsetPath);
  } catch {
    return { lines: [], nextOffset: 0, reset: false, skippedCount: 0 };
  }
}

function readNewLinesInner(
  logPath: string,
  offsetPath: string,
): ReadNewLinesResult {
  const storedOffset = readStoredOffset(offsetPath);

  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    // Missing/unreadable log: no lines, keep the stored offset.
    return {
      lines: [],
      nextOffset: storedOffset,
      reset: false,
      skippedCount: 0,
    };
  }

  let offset = storedOffset;
  let reset = false;
  if (offset > size) {
    offset = 0;
    reset = true;
  }

  if (offset === size) {
    writeStoredOffset(offsetPath, size);
    return { lines: [], nextOffset: size, reset, skippedCount: 0 };
  }

  const lines: string[] = [];
  let skippedCount = 0;
  let lineChunks: Buffer[] = [];
  let lineLen = 0;
  let skipping = false;
  // Byte offset just past the last `\n` seen; trailing partials hold here.
  let lastCompleteEnd = offset;
  let chunkStart = offset;

  let fd = -1;
  try {
    fd = openSync(logPath, "r");
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    while (chunkStart < size) {
      const toRead = Math.min(READ_CHUNK_BYTES, size - chunkStart);
      const bytesRead = readSync(fd, buf, 0, toRead, chunkStart);
      if (bytesRead <= 0) break;
      let segStart = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] !== NEWLINE_BYTE) continue;
        const segLen = i - segStart;
        if (skipping) {
          // An oversized line just terminated: count it, drop its bytes.
          skippedCount++;
          skipping = false;
          lineChunks = [];
          lineLen = 0;
        } else if (lineLen + segLen > MAX_LINE_BYTES) {
          skippedCount++;
          lineChunks = [];
          lineLen = 0;
        } else {
          if (segLen > 0) {
            lineChunks.push(Buffer.from(buf.subarray(segStart, i)));
          }
          lines.push(Buffer.concat(lineChunks).toString("utf8"));
          lineChunks = [];
          lineLen = 0;
        }
        lastCompleteEnd = chunkStart + i + 1;
        segStart = i + 1;
      }
      // Trailing segment with no terminator yet: buffer it bounded
      // (or discard-and-count-bytes while skipping) for the next chunk.
      if (segStart < bytesRead) {
        const segLen = bytesRead - segStart;
        if (skipping) {
          lineLen += segLen;
        } else if (lineLen + segLen > MAX_LINE_BYTES) {
          skipping = true;
          lineChunks = [];
          lineLen += segLen;
        } else {
          lineChunks.push(Buffer.from(buf.subarray(segStart, bytesRead)));
          lineLen += segLen;
        }
      }
      chunkStart += bytesRead;
    }
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // Descriptor cleanup must never break the caller.
      }
    }
  }

  writeStoredOffset(offsetPath, lastCompleteEnd);
  return { lines, nextOffset: lastCompleteEnd, reset, skippedCount };
}
