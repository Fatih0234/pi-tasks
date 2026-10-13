# Job-link watcher pilot (dry-run): diary guide and go-live bar

The job-link watcher matches async-bash background jobs to pi-tasks tasks
via the `task_id` link recorded on the async-bash JSONL event log. During
the pilot it is **dry-run only**: it reads the log, appends observations to
a diary file, and never writes to the task store.

Wiring: `checkJobLinks(store)` in `src/job-link-check.ts`, called once per
`turn_start` in `src/index.ts` inside try/catch. The whole pass is skipped
when `PI_ASYNC_BASH_EVENT_LOG` is unset. Pure matching lives in
`src/job-link-watcher.ts`; the diary tail lives in `src/job-link-diary.ts`.

## Diary location

For a log at `<log>` (the value of `PI_ASYNC_BASH_EVENT_LOG`):

| File | Path | Purpose |
|------|------|---------|
| Event log (input, owned by async-bash) | `<log>` | `started` / `settled` JSONL lines |
| Offset (watcher state) | `<log>.offset` | Plain-decimal byte offset; new-bytes-only tail |
| Diary (watcher output, append-only) | `<log>.watcher-diary.jsonl` | One JSON object per observed outcome |

`diaryPathFor(logPath)` returns `<log>.watcher-diary.jsonl`; the offset
sibling is `<log>.offset`. A second call with no log growth appends
nothing. If the log is rotated or truncated (stored offset past EOF), the
tail re-baselines from byte 0.

## Entry schema

One JSON object per line:

```json
{
  "diary_ts": 1729000000000,
  "outcome": { "kind": "settled", "job_id": "abc", "task_id": "3",
               "exitCode": 0, "status": "completed", "ts": 1728999999000 },
  "would_write": { "task_id": "3", "metadata_key": "asyncBashOutcomes",
                   "note": { "job_id": "abc", "exitCode": 0,
                             "status": "completed", "ts": 1728999999000 } }
}
```

- `diary_ts`: `Date.now()` at append time (one timestamp per batch).
- `outcome`: the verbatim matcher outcome. `kind` is `settled`,
  `died-with-session`, or `flag` (`duplicate-start`, `orphan-settle`,
  `unknown-task`, `late-settle`).
- `would_write`: the payload a live watcher *would* store, or `null`
  when there is nothing to write (`died-with-session` and every `flag`
  record `null`). For `settled` outcomes of existing tasks it is
  `{ task_id, metadata_key: "asyncBashOutcomes", note: { job_id, exitCode,
  status, ts } }`.

`would_write` is a statement of intent for human review, not a write. The
pilot never touches tasks: no notes appended, no metadata keys created, no
reminder state changed.

## How to read the diary

1. Each line is one outcome. `outcome.kind === "settled"` with a non-null
   `would_write` means "on going live this would have appended `note` to
   `metadata.asyncBashOutcomes` on task `task_id`".
2. `outcome.kind === "flag"` lines are matcher diagnostics, not errors:
   `duplicate-start` (job started twice), `orphan-settle` (settle with no
   visible start), `unknown-task` (settled for a task id the store does
   not have), `late-settle` (settle paired with a start older than the
   orphan horizon). All record `would_write: null`.
3. `outcome.kind === "died-with-session"` means a linked start stayed
   pending past the orphan horizon (see below) with no settle.
4. Spot-check an entry by comparing `outcome.job_id` / `task_id` against
   the event-log lines for that `job_id` (`grep <job_id> <log>`): the
   settle line's `task_id` and `exitCode`/`status` must match the diary
   `outcome` verbatim. Any mismatch is a false match.

## Orphan rule (24 h)

A linked `started` line with no matching `settled` line stays pending for
24 hours (`DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000` in
`src/job-link-watcher.ts`, applied by `applyExpiry` on every pass). Past
that horizon the watcher records `{ "kind": "died-with-session", "job_id",
"task_id", "lastSeenTs" }` with `would_write: null` and moves on. Expiry
never deletes information and never writes to the store. A settle that
arrives in the same batch as its expired start still pairs, and is flagged
`late-settle` so the lateness stays visible.

## Revert

Unset the env var:

```bash
unset PI_ASYNC_BASH_EVENT_LOG
```

The diary is inert: with the variable unset `checkJobLinks` returns before
any filesystem access, so no diary, offset, or log read happens. Nothing
was ever written to tasks during the pilot, so there is nothing to undo in
the store. Delete the diary file (and its `.offset` sibling) if unwanted:

```bash
rm -f "<log>.watcher-diary.jsonl" "<log>.offset"
```

No code changes are needed to stand the pilot down.

## Go-live bar

Move the watcher from observing to acting only when ALL of the
following hold:

(a) >= 20 linked `settled` outcomes observed in the diary.
(b) 0 false matches across a human spot-check of every diary entry
    (minimum 20 entries checked).
(c) >= 1 `died-with-session` handled without a stuck suppression
    (the orphan appears once in the diary; later passes stay quiet).
(d) 0 watcher-caused errors in the logs (no diary/offset I/O failures,
    no hook exceptions attributable to the watcher).

Acting scope when live: on `settled`, append `note` to
`metadata.asyncBashOutcomes` on the linked task. Reminder stand-down is
decided THEN, not now: this pilot grants no authority to change reminder
cadence, auto-clear, or widget behaviour, and going live must re-decide
that scope explicitly.
