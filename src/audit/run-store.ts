import { randomUUID } from 'node:crypto';

import type { Pool } from './db.js';

export const RUN_STATUSES = ['running', 'completed', 'failed', 'interrupted', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type TerminalStatus = Exclude<RunStatus, 'running'>;

/** Identifies one request: one Slack mention, one queue job, one run. */
export interface RunKey {
  readonly jobId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly requesterId: string;
  readonly projectId: string;
  readonly queuedAt: Date;
}

export interface RunRecord {
  readonly id: string;
  readonly jobId: string;
  readonly status: RunStatus;
  readonly outcome: string | null;
  readonly attempt: number;
  readonly toolCalls: number;
  readonly placeholderTs: string | null;
  readonly postedAt: Date | null;
}

export interface RunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly turns: number;
}

export interface FinishInput {
  readonly status: TerminalStatus;
  readonly outcome: string;
  readonly model?: string | undefined;
  readonly usage?: RunUsage | undefined;
  /** Extra non-content details for the audit event, for example the budget that was hit. */
  readonly details?: Record<string, unknown> | undefined;
  readonly actor?: string | undefined;
}

/**
 * `new`: first time this job runs. `restarted`: a previous attempt died mid-run.
 * `finished`: the run already reached a terminal status (the job was delivered again).
 */
export type BeginState = 'new' | 'restarted' | 'finished';

export interface BeginResult {
  readonly run: RunRecord;
  readonly state: BeginState;
}

export interface AuditEventInput {
  readonly runId?: string | undefined;
  readonly kind: string;
  readonly actor?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}

/** Run state plus the append-only audit log. Every method throws if Postgres is unavailable. */
export interface RunStore {
  begin(
    key: RunKey,
    init: { model: string; promptVersion: string; correlationId?: string },
  ): Promise<BeginResult>;
  setPlaceholder(runId: string, ts: string): Promise<void>;
  finish(runId: string, input: FinishInput): Promise<void>;
  markPosted(runId: string): Promise<void>;
  getByJobId(jobId: string): Promise<RunRecord | undefined>;
  appendEvent(event: AuditEventInput): Promise<void>;
}

interface RunRow {
  id: string;
  job_id: string;
  status: RunStatus;
  outcome: string | null;
  attempt: number;
  tool_calls: number;
  placeholder_ts: string | null;
  posted_at: Date | null;
}

const RUN_COLUMNS = 'id, job_id, status, outcome, attempt, tool_calls, placeholder_ts, posted_at';

function firstRow(rows: RunRow[]): RunRow {
  const row = rows[0];
  if (row === undefined) throw new Error('query returned no row');
  return row;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    outcome: row.outcome,
    attempt: row.attempt,
    toolCalls: row.tool_calls,
    placeholderTs: row.placeholder_ts,
    postedAt: row.posted_at,
  };
}

export class PgRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async begin(
    key: RunKey,
    init: { model: string; promptVersion: string; correlationId?: string },
  ): Promise<BeginResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = await client.query<RunRow>(
        `select ${RUN_COLUMNS} from runs where job_id = $1 for update`,
        [key.jobId],
      );
      const found = existing.rows[0];
      let result: BeginResult;
      if (found === undefined) {
        const inserted = await client.query<RunRow>(
          `insert into runs (id, job_id, event_id, team_id, channel_id, thread_ts, message_ts,
             requester_id, project_id, status, model, prompt_version, queued_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', $10, $11, $12)
           returning ${RUN_COLUMNS}`,
          [
            randomUUID(),
            key.jobId,
            key.eventId,
            key.teamId,
            key.channelId,
            key.threadTs,
            key.messageTs,
            key.requesterId,
            key.projectId,
            init.model,
            init.promptVersion,
            key.queuedAt,
          ],
        );
        result = { run: toRecord(firstRow(inserted.rows)), state: 'new' };
        await this.insertEvent(client, {
          runId: result.run.id,
          kind: 'run.started',
          actor: key.requesterId,
          correlationId: init.correlationId,
          data: { projectId: key.projectId, model: init.model, promptVersion: init.promptVersion },
        });
      } else if (found.status === 'running') {
        const updated = await client.query<RunRow>(
          `update runs set attempt = attempt + 1, updated_at = now() where id = $1
           returning ${RUN_COLUMNS}`,
          [found.id],
        );
        result = { run: toRecord(firstRow(updated.rows)), state: 'restarted' };
        await this.insertEvent(client, {
          runId: found.id,
          kind: 'run.restarted',
          correlationId: init.correlationId,
          data: { attempt: result.run.attempt },
        });
      } else {
        result = { run: toRecord(found), state: 'finished' };
      }
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setPlaceholder(runId: string, ts: string): Promise<void> {
    await this.pool.query('update runs set placeholder_ts = $2, updated_at = now() where id = $1', [
      runId,
      ts,
    ]);
  }

  async finish(runId: string, input: FinishInput): Promise<void> {
    const usage = input.usage;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query(
        `update runs set status = $2, outcome = $3, model = coalesce($4, model),
           turns = $5, input_tokens = $6, output_tokens = $7, cache_read_tokens = $8,
           cache_creation_tokens = $9, cost_usd = $10, finished_at = now(), updated_at = now()
         where id = $1 and status = 'running'`,
        [
          runId,
          input.status,
          input.outcome,
          input.model ?? null,
          usage?.turns ?? null,
          usage?.inputTokens ?? 0,
          usage?.outputTokens ?? 0,
          usage?.cacheReadTokens ?? 0,
          usage?.cacheCreationTokens ?? 0,
          usage?.costUsd ?? 0,
        ],
      );
      if (updated.rowCount !== 1) throw new Error(`run ${runId} is not running`);
      await this.insertEvent(client, {
        runId,
        kind: 'run.finished',
        actor: input.actor,
        data: { status: input.status, outcome: input.outcome, usage, ...input.details },
      });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markPosted(runId: string): Promise<void> {
    await this.pool.query(
      'update runs set posted_at = now(), updated_at = now() where id = $1 and posted_at is null',
      [runId],
    );
  }

  async getByJobId(jobId: string): Promise<RunRecord | undefined> {
    const result = await this.pool.query<RunRow>(
      `select ${RUN_COLUMNS} from runs where job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async appendEvent(event: AuditEventInput): Promise<void> {
    await this.insertEvent(this.pool, event);
  }

  private async insertEvent(db: Pick<Pool, 'query'>, event: AuditEventInput): Promise<void> {
    await db.query(
      `insert into audit_events (run_id, kind, actor, correlation_id, data)
       values ($1, $2, $3, $4, $5)`,
      [
        event.runId ?? null,
        event.kind,
        event.actor ?? null,
        event.correlationId ?? null,
        JSON.stringify(event.data ?? {}),
      ],
    );
  }
}
