-- =====================================================================
-- Zintra حاضر — core schema
-- ---------------------------------------------------------------------
-- Conventions
--   * All timestamps are timestamptz (UTC). Work dates are `date` values
--     computed in the business timezone (settings.business_timezone).
--   * Money is integer piastres (1 EGP = 100 piastres), never floats.
--   * Point counters are DERIVED from active point_events (see the
--     v_point_totals view) — never stored as mutable integers.
--   * Every table has Row Level Security enabled (policies in the next
--     migration). Server-authority writes go through Edge Functions /
--     SECURITY DEFINER functions executed by the service role.
--   * `private` schema is not exposed through the Data API.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- enums
create type public.app_role        as enum ('owner', 'staff');
create type public.point_color     as enum ('green', 'red', 'black');
create type public.point_source    as enum ('auto_window', 'auto_absence', 'owner_outcome', 'owner_manual', 'leave_reversal');
create type public.point_status    as enum ('active', 'pending_approval', 'declined', 'cancelled');
create type public.leave_type      as enum ('personal', 'sick');
create type public.request_status  as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.reward_status   as enum ('pending', 'approved', 'paid', 'rejected');
create type public.holiday_kind    as enum ('official', 'company');
create type public.notify_channel  as enum ('telegram', 'web_push');
create type public.delivery_status as enum ('pending', 'sending', 'sent', 'failed', 'skipped', 'dead');
create type public.decision_channel as enum ('dashboard', 'telegram');

-- ---------------------------------------------------------- utilities
create or replace function private.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ============================================================ profiles
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete restrict,
  full_name_ar      text not null check (char_length(btrim(full_name_ar)) between 2 and 80),
  full_name_en      text not null check (char_length(btrim(full_name_en)) between 2 and 80),
  phone             text check (phone is null or phone ~ '^\+?[0-9 ]{7,20}$'),
  role              public.app_role not null default 'staff',
  active            boolean not null default true,
  -- null = follow settings.shift_reminders_default
  reminders_enabled boolean,
  preferred_language text check (preferred_language in ('ar', 'en')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deactivated_at    timestamptz
);
comment on table public.profiles is
  'One row per person (owner or staff). Auth users have a synthetic internal email <id>@staff.invalid that is never shown or used to sign in by hand.';
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ==================================================== employee_salaries
-- OWNER-ONLY. No staff policy exists at all (see RLS migration).
create table public.employee_salaries (
  employee_id             uuid primary key references public.profiles (id) on delete cascade,
  monthly_salary_piastres bigint check (monthly_salary_piastres is null or monthly_salary_piastres between 0 and 100000000000),
  updated_by              uuid references public.profiles (id),
  updated_at              timestamptz not null default now()
);

-- ========================================================= login_codes
-- Only salted bcrypt hashes. Never plaintext. No browser access (RLS with
-- zero policies); only the service role reads/writes.
create table public.login_codes (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  code_hash    text not null check (code_hash ~ '^\$2[aby]\$\d{2}\$.{53}$'),
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);
create unique index login_codes_one_current on public.login_codes (profile_id) where revoked_at is null;

-- ====================================================== login_attempts
-- Stores HMAC'd client identifiers only — never the submitted code.
create table public.login_attempts (
  id                 bigint generated always as identity primary key,
  attempted_at       timestamptz not null default now(),
  client_ip_hash     text not null,
  device_id_hash     text not null,
  success            boolean not null,
  refused_locked     boolean not null default false,
  matched_profile_id uuid references public.profiles (id) on delete set null
);
create index login_attempts_ip_time on public.login_attempts (client_ip_hash, attempted_at desc);
create index login_attempts_dev_time on public.login_attempts (device_id_hash, attempted_at desc);
create index login_attempts_time on public.login_attempts (attempted_at desc) where not success;

create table public.login_lockouts (
  id           bigint generated always as identity primary key,
  scope        text not null check (scope in ('client', 'global')),
  key_hash     text not null,          -- ip or device hash; 'global' for the global throttle
  level        smallint not null check (level >= 1),
  locked_until timestamptz not null,
  created_at   timestamptz not null default now()
);
create index login_lockouts_key on public.login_lockouts (key_hash, locked_until desc);

-- ===================================================== device_sessions
-- Device info recorded by the login function for each Supabase session.
-- Session liveness/last activity comes from auth.sessions (joined in
-- private.list_sessions); revocation deletes the auth.sessions row.
create table public.device_sessions (
  session_id         uuid primary key,
  profile_id         uuid not null references public.profiles (id) on delete cascade,
  created_at         timestamptz not null default now(),
  user_agent_summary text,
  approx_ip          text,          -- truncated (/24 or /48), never the full address
  revoked_at         timestamptz,
  revoked_by         uuid references public.profiles (id)
);
create index device_sessions_profile on public.device_sessions (profile_id);

-- ============================================================ settings
create table public.settings (
  id                         boolean primary key default true check (id),
  business_timezone          text not null default 'Africa/Cairo',
  default_language           text not null default 'ar' check (default_language in ('ar', 'en')),
  -- office geofence (single zone)
  geofence_lat               numeric(10, 7) not null default 29.9831944 check (geofence_lat between -90 and 90),
  geofence_lng               numeric(10, 7) not null default 31.3239444 check (geofence_lng between -180 and 180),
  geofence_radius_m          integer not null default 100 check (geofence_radius_m between 10 and 5000),
  -- work day
  work_start_time            time not null default '09:00',
  work_end_time              time not null default '17:00',
  absence_cutoff             time not null default '11:30',
  missing_checkout_policy    text not null default 'flag_for_owner' check (missing_checkout_policy in ('flag_for_owner')),
  -- points & money (integer piastres)
  red_penalty_piastres       bigint not null default 5000   check (red_penalty_piastres between 0 and 100000000),
  black_penalty_piastres     bigint not null default 100000 check (black_penalty_piastres between 0 and 100000000),
  first_red_warning          boolean not null default true,
  reward_period              text not null default 'calendar_month' check (reward_period in ('calendar_month')),
  green_reward_threshold     integer not null default 30 check (green_reward_threshold between 1 and 1000),
  reward_amount_piastres     bigint not null default 10000  check (reward_amount_piastres between 0 and 100000000),
  payout_methods             text[] not null default array['instapay', 'vodafone_cash'],
  -- owner notifications (Telegram only; token lives in Edge Function secrets)
  owner_alert_channel        text not null default 'telegram' check (owner_alert_channel in ('telegram', 'off')),
  owner_telegram_chat_id     text not null default '1360140225' check (owner_telegram_chat_id ~ '^-?[0-9]{3,20}$'),
  notify_events              text[] not null default array['red_point', 'black_pending', 'reward_request', 'early_leave_request', 'security', 'digest', 'weekly_summary'],
  digest_enabled             boolean not null default true,
  digest_time                time not null default '12:00',
  weekly_summary_enabled     boolean not null default true,
  weekly_summary_dow         smallint check (weekly_summary_dow between 0 and 6), -- null = last work day of the week
  weekly_summary_time        time not null default '18:00',
  -- staff web push reminders
  shift_reminders_default    boolean not null default true,
  shift_reminder_lead_min    smallint not null default 15 check (shift_reminder_lead_min between 1 and 120),
  missed_checkin_reminder_enabled boolean not null default true,
  missed_checkin_lead_min    smallint not null default 15 check (missed_checkin_lead_min between 1 and 120),
  leaderboard_visible        boolean not null default true,
  -- login security
  code_length                smallint not null default 8 check (code_length between 6 and 12),
  lockout_max_failures       smallint not null default 5 check (lockout_max_failures between 3 and 20),
  lockout_window_min         smallint not null default 15 check (lockout_window_min between 1 and 1440),
  lockout_durations_min      integer[] not null default array[15, 60, 1440],
  global_failure_limit_per_hour integer not null default 50 check (global_failure_limit_per_hour between 10 and 10000),
  -- versioning
  rule_version               integer not null default 1,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references public.profiles (id),
  constraint settings_work_hours check (work_start_time < work_end_time),
  constraint settings_tz_valid check (now() at time zone business_timezone is not null),
  constraint settings_lockout_durations check (cardinality(lockout_durations_min) between 1 and 6)
);
comment on table public.settings is 'Singleton row of owner-editable business rules. Contains no secrets.';

-- ================================================= check_in_windows
create table public.check_in_windows (
  id                 uuid primary key default gen_random_uuid(),
  day_of_week        smallint not null check (day_of_week between 0 and 6), -- 0 = Sunday
  label_ar           text not null check (char_length(label_ar) between 1 and 40),
  label_en           text not null check (char_length(label_en) between 1 and 40),
  start_time         time not null,
  end_time           time not null,
  enabled            boolean not null default true,
  awards_green_point boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint window_order check (start_time < end_time),
  -- start-inclusive / end-exclusive, no overlap among enabled windows of a day
  constraint windows_no_overlap exclude using gist (
    day_of_week with =,
    tsrange('2000-01-01'::date + start_time, '2000-01-01'::date + end_time, '[)') with &&
  ) where (enabled)
);
create trigger check_in_windows_touch before update on public.check_in_windows
  for each row execute function private.touch_updated_at();

-- ======================================================== day_rules
create table public.day_rules (
  day_of_week      smallint primary key check (day_of_week between 0 and 6),
  is_work_day      boolean not null,
  check_in_enabled boolean not null,
  points_enabled   boolean not null,
  updated_at       timestamptz not null default now()
);

-- ===================================================== attendance_days
create table public.attendance_days (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          uuid not null references public.profiles (id) on delete restrict,
  work_date            date not null,
  checked_in_at        timestamptz,
  check_in_lat         numeric(10, 7) check (check_in_lat between -90 and 90),
  check_in_lng         numeric(10, 7) check (check_in_lng between -180 and 180),
  check_in_accuracy_m  numeric(8, 2) check (check_in_accuracy_m >= 0),
  checked_out_at       timestamptz,
  check_out_lat        numeric(10, 7) check (check_out_lat between -90 and 90),
  check_out_lng        numeric(10, 7) check (check_out_lng between -180 and 180),
  check_out_accuracy_m numeric(8, 2) check (check_out_accuracy_m >= 0),
  worked_minutes       integer check (worked_minutes >= 0),
  window_id            uuid references public.check_in_windows (id) on delete set null,
  window_label_snapshot text,
  check_in_outcome     text check (check_in_outcome in ('green', 'red', 'none')),
  point_event_id       uuid,  -- fk added after point_events
  missing_checkout     boolean not null default false,
  corrected            boolean not null default false,
  corrected_by         uuid references public.profiles (id),
  corrected_at         timestamptz,
  correction_reason    text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint one_day_per_employee unique (employee_id, work_date),
  constraint checkout_after_checkin check (checked_out_at is null or (checked_in_at is not null and checked_out_at > checked_in_at))
);
create index attendance_days_date on public.attendance_days (work_date);
create trigger attendance_days_touch before update on public.attendance_days
  for each row execute function private.touch_updated_at();

-- ======================================================== point_events
create table public.point_events (
  id                        uuid primary key default gen_random_uuid(),
  employee_id               uuid not null references public.profiles (id) on delete restrict,
  effective_work_date       date not null,
  reward_period             date not null check (extract(day from reward_period) = 1), -- first day of the period month
  attendance_day_id         uuid references public.attendance_days (id) on delete set null,
  idempotency_key           text not null unique check (char_length(idempotency_key) between 3 and 200),
  applied_rule_version      integer not null,
  color                     public.point_color not null,
  delta                     integer not null check (delta between -1000 and 1000 and delta <> 0),
  source                    public.point_source not null,
  outcome_category          text check (outcome_category is null or outcome_category in ('shipment_cleared', 'customs_ready', 'deal_closed', 'custom')),
  status                    public.point_status not null default 'active',
  warning_only              boolean not null default false,
  deduction_amount_piastres bigint not null default 0 check (deduction_amount_piastres >= 0),
  approved_by               uuid references public.profiles (id),
  approved_at               timestamptz,
  amount_confirmed_by       uuid references public.profiles (id),  -- explicit owner confirmation of a deduction (Step 6)
  amount_confirmed_at       timestamptz,
  reason                    text check (reason is null or char_length(reason) <= 500),
  created_by                uuid references public.profiles (id),
  created_at                timestamptz not null default now(),
  reverses_event_id         uuid references public.point_events (id),
  constraint outcome_needs_category check (source <> 'owner_outcome' or outcome_category is not null),
  constraint manual_needs_reason check (source not in ('owner_manual', 'owner_outcome') or reason is not null),
  constraint warning_has_no_deduction check (not warning_only or deduction_amount_piastres = 0)
);
create index point_events_emp_period on public.point_events (employee_id, reward_period) where status = 'active';
create index point_events_emp_date on public.point_events (employee_id, effective_work_date);
-- at most one reversal per reversed event
create unique index point_events_one_reversal on public.point_events (reverses_event_id) where reverses_event_id is not null and status = 'active';
alter table public.attendance_days
  add constraint attendance_point_event_fk foreign key (point_event_id) references public.point_events (id) on delete set null;

-- =================================================== leave_requests
create table public.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.profiles (id) on delete restrict,
  type          public.leave_type not null,
  from_date     date not null,
  to_date       date not null,
  reason        text check (reason is null or char_length(reason) <= 500),
  status        public.request_status not null default 'pending',
  admin_comment text check (admin_comment is null or char_length(admin_comment) <= 500),
  decided_by    uuid references public.profiles (id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint leave_dates check (from_date <= to_date and to_date - from_date <= 60)
);
create index leave_requests_emp on public.leave_requests (employee_id, from_date, to_date);
create trigger leave_requests_touch before update on public.leave_requests
  for each row execute function private.touch_updated_at();

-- ============================================= early_leave_requests
create table public.early_leave_requests (
  id                    bigint generated always as identity primary key, -- short id for Telegram replies ("approve 7")
  employee_id           uuid not null references public.profiles (id) on delete restrict,
  work_date             date not null,
  requested_leave_time  time not null,
  reason                text check (reason is null or char_length(reason) <= 500),
  status                public.request_status not null default 'pending',
  admin_comment         text check (admin_comment is null or char_length(admin_comment) <= 500),
  decided_by            uuid references public.profiles (id),
  decided_at            timestamptz,
  decision_channel      public.decision_channel,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index early_leave_one_pending on public.early_leave_requests (employee_id, work_date) where status = 'pending';
create unique index early_leave_one_approved on public.early_leave_requests (employee_id, work_date) where status = 'approved';
create trigger early_leave_touch before update on public.early_leave_requests
  for each row execute function private.touch_updated_at();

-- ================================================== public_holidays
create table public.public_holidays (
  id           uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name_ar      text not null check (char_length(name_ar) between 2 and 80),
  name_en      text not null check (char_length(name_en) between 2 and 80),
  kind         public.holiday_kind not null default 'official',
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger public_holidays_touch before update on public.public_holidays
  for each row execute function private.touch_updated_at();

-- ================================================== reward_requests
create table public.reward_requests (
  id                      uuid primary key default gen_random_uuid(),
  employee_id             uuid not null references public.profiles (id) on delete restrict,
  period_month            date not null check (extract(day from period_month) = 1),
  reward_amount_piastres  bigint not null check (reward_amount_piastres >= 0),
  applied_rule_version    integer not null,
  payout_method           text not null check (payout_method in ('instapay', 'vodafone_cash')),
  payout_number           text not null check (payout_number ~ '^[0-9A-Za-z@._+ -]{4,64}$'),
  status                  public.reward_status not null default 'pending',
  replaces_request_id     uuid references public.reward_requests (id),
  decided_by              uuid references public.profiles (id),
  decided_at              timestamptz,
  decision_comment        text check (decision_comment is null or char_length(decision_comment) <= 500),
  paid_at                 timestamptz,
  paid_reference          text check (paid_reference is null or char_length(paid_reference) <= 120),
  needs_owner_review      boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint paid_has_time check (status <> 'paid' or paid_at is not null)
);
-- only one pending/approved/paid request per employee per period
create unique index reward_one_live_per_period on public.reward_requests (employee_id, period_month) where status in ('pending', 'approved', 'paid');
create trigger reward_requests_touch before update on public.reward_requests
  for each row execute function private.touch_updated_at();

-- ================================================ monthly_deductions
create table public.monthly_deductions (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          uuid not null references public.profiles (id) on delete restrict,
  month                date not null check (extract(day from month) = 1),
  red_count            integer not null default 0 check (red_count >= 0),   -- chargeable only (warnings excluded)
  black_count          integer not null default 0 check (black_count >= 0), -- approved only
  red_amount_piastres  bigint not null default 0,
  black_amount_piastres bigint not null default 0,
  bonus_amount_piastres bigint not null default 0,
  total_amount_piastres bigint not null default 0,
  calculation_version  integer not null default 1,
  computed_at          timestamptz not null default now(),
  constraint monthly_deductions_unique unique (employee_id, month)
);

-- ======================================================== payroll_reports
create table public.payroll_reports (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references public.profiles (id) on delete restrict,
  month                 date not null check (extract(day from month) = 1),
  calculation_version   integer not null default 1,
  calculated_at         timestamptz not null default now(),
  worked_minutes        integer not null default 0,
  unresolved_flags      jsonb not null default '[]'::jsonb,
  points_breakdown      jsonb not null default '{}'::jsonb,
  warnings_count        integer not null default 0,
  deductions_piastres   bigint not null default 0,
  bonuses_earned_piastres bigint not null default 0,
  bonuses_paid_piastres bigint not null default 0,
  net_adjustment_piastres bigint not null default 0,  -- unpaid earned bonuses minus approved deductions (NOT net pay)
  incomplete            boolean not null default false,
  finalized_at          timestamptz,
  source_refs           jsonb not null default '{}'::jsonb,
  constraint payroll_reports_unique unique (employee_id, month)
);

-- ================================================== notification_outbox
create table public.notification_outbox (
  id                 uuid primary key default gen_random_uuid(),
  dedupe_key         text not null unique,       -- unique event/channel/recipient key
  event_type         text not null,
  event_ref          text,
  channel            public.notify_channel not null,
  recipient          text not null,              -- Telegram chat id or push subscription id
  payload            jsonb not null default '{}'::jsonb,  -- safe summary: never codes, never salary
  status             public.delivery_status not null default 'pending',
  attempt_count      integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  last_error         text,
  provider_reference text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index outbox_due on public.notification_outbox (next_attempt_at) where status in ('pending', 'failed');

-- ================================================== push_subscriptions
create table public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint        text not null unique check (endpoint ~ '^https://'),
  p256dh          text not null,
  auth_key        text not null,
  device_label    text check (device_label is null or char_length(device_label) <= 120),
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  disabled_at     timestamptz
);
create index push_subscriptions_emp on public.push_subscriptions (employee_id) where enabled;

-- ============================================================ audit_log
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,                 -- profile id, or null for system jobs
  actor_kind  text not null default 'user' check (actor_kind in ('user', 'system', 'telegram')),
  action      text not null,
  target_table text,
  target_id   text,
  before      jsonb,
  after       jsonb,
  reason      text
);
create index audit_log_target on public.audit_log (target_table, target_id);
create index audit_log_time on public.audit_log (occurred_at desc);

-- ============================================================ job_runs
-- Database-backed run records for scheduled jobs (catch-up + idempotency).
create table public.job_runs (
  id          bigint generated always as identity primary key,
  job_name    text not null,
  run_key     text not null,          -- e.g. work date or ISO week the run covers
  status      text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'skipped')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  detail      jsonb not null default '{}'::jsonb,
  constraint job_runs_unique unique (job_name, run_key)
);

-- ===================================================== bootstrap tokens
-- One-time tokens (stored hashed) that allow the bootstrap Edge Function
-- to create the initial owner / dev seed users. Private schema only.
create table private.bootstrap_tokens (
  token_hash text primary key,        -- sha256 hex of the token
  purpose    text not null check (purpose in ('owner', 'seed_staff')),
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- ======================================== derived counters (no drift)
create view public.v_point_totals with (security_invoker = true) as
select
  pe.employee_id,
  pe.reward_period,
  coalesce(sum(pe.delta) filter (where pe.color = 'green'), 0)::int as green,
  coalesce(sum(pe.delta) filter (where pe.color = 'red'), 0)::int   as red,
  coalesce(sum(pe.delta) filter (where pe.color = 'black'), 0)::int as black
from public.point_events pe
where pe.status = 'active'
group by pe.employee_id, pe.reward_period;
comment on view public.v_point_totals is 'Per-employee, per-period totals derived from ACTIVE point events only. Pending/declined never count.';

-- ======================================================== RLS everywhere
alter table public.profiles            enable row level security;
alter table public.employee_salaries   enable row level security;
alter table public.login_codes         enable row level security;
alter table public.login_attempts      enable row level security;
alter table public.login_lockouts      enable row level security;
alter table public.device_sessions     enable row level security;
alter table public.settings            enable row level security;
alter table public.check_in_windows    enable row level security;
alter table public.day_rules           enable row level security;
alter table public.attendance_days     enable row level security;
alter table public.point_events        enable row level security;
alter table public.leave_requests      enable row level security;
alter table public.early_leave_requests enable row level security;
alter table public.public_holidays     enable row level security;
alter table public.reward_requests     enable row level security;
alter table public.monthly_deductions  enable row level security;
alter table public.payroll_reports     enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.audit_log           enable row level security;
alter table public.job_runs            enable row level security;
alter table private.bootstrap_tokens   enable row level security;

-- Table privileges: anon gets nothing; authenticated gets SELECT
-- everywhere (RLS decides which rows) and INSERT/UPDATE/DELETE only on the
-- few tables where a person acts on their own rows.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
grant select on all tables in schema public to authenticated;
-- credential/security tables: not even SELECT for browser roles
revoke all on public.login_codes, public.login_attempts, public.login_lockouts from authenticated;
grant insert (employee_id, type, from_date, to_date, reason) on public.leave_requests to authenticated;
grant insert (employee_id, work_date, requested_leave_time, reason) on public.early_leave_requests to authenticated;
grant insert, update, delete on public.push_subscriptions to authenticated;
grant all on all tables in schema public to service_role;
grant all on all tables in schema private to service_role;
grant usage, select on all sequences in schema public to service_role;
