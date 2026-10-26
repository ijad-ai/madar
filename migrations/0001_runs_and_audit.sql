-- Phase 1: run state and the append-only audit log.
-- No message content is stored here in Phase 1: only ids, outcomes and usage.

create table runs (
  id uuid primary key,
  job_id text not null unique,
  event_id text not null,
  team_id text not null,
  channel_id text not null,
  thread_ts text not null,
  message_ts text not null,
  requester_id text not null,
  project_id text not null,
  status text not null
    check (status in ('running', 'completed', 'failed', 'interrupted', 'cancelled')),
  -- Finer-grained result, for example budget_tokens or model_api_error.
  outcome text,
  model text,
  prompt_version text,
  attempt integer not null default 1 check (attempt >= 1),
  tool_calls integer not null default 0,
  turns integer,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_creation_tokens bigint not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  placeholder_ts text,
  queued_at timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- When the final text reached Slack. Null with a terminal status means "not yet posted".
  posted_at timestamptz,
  updated_at timestamptz not null default now()
);

create index runs_thread_idx on runs (team_id, channel_id, thread_ts, started_at);
create index runs_requester_idx on runs (requester_id, started_at);

create table audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  run_id uuid references runs (id),
  kind text not null,
  actor text,
  correlation_id text,
  data jsonb not null default '{}'::jsonb
);

create index audit_events_run_idx on audit_events (run_id, id);

-- Append-only: rows can be added, never changed or removed. Retention purges (Phase 8)
-- will run through a dedicated, audited maintenance path.
create function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only (% blocked)', tg_op;
end;
$$;

create trigger audit_events_no_update_delete
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

create trigger audit_events_no_truncate
  before truncate on audit_events
  for each statement execute function audit_events_append_only();
