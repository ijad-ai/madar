# queue

**Phase 1 (built).** From an accepted mention to a posted outcome.

| File                  | What it does                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `jobs.ts`             | The job schema: ids and timestamps only, never message text.                                                     |
| `producer.ts`         | Registers a job in its thread's order, then enqueues it.                                                         |
| `thread-scheduler.ts` | Strict per-thread order, a job-owned thread lock, and stop requests (D-017).                                     |
| `run-processor.ts`    | One run: audit first, the agent, then the outcome into the placeholder. Restarts a dead run once (D-004, D-029). |
| `progress.ts`         | Throttled, best-effort progress edits.                                                                           |
| `worker.ts`           | The BullMQ worker, plus a backstop for jobs BullMQ gives up on.                                                  |

**Phase 5:** a run waiting for approval frees its worker but keeps its thread lock; `stop` also cancels the pending approval.
