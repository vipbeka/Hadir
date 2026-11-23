# Owner Telegram reports — features 5–8

All four features ship **off**. Nothing is sent until the owner turns a
feature on in **الإعدادات → تقارير تيليجرام للمالك** *and* the owner's chat is
verified as a private Telegram chat.

## How delivery works

- Every report is rendered on the server and stored as a snapshot in
  `private.owner_reports` (not exposed to the API). Payroll figures live only
  there.
- The outbox row (`event_type = 'owner_report'`) holds only `{report_id, part}`.
  It never holds text, names or amounts.
- The dispatcher fetches each part at send time (`svc_owner_report_part`). It
  sends only if the destination is still the **verified private owner chat**.
  Otherwise the part is blocked and never sent anywhere else.
- **Verification.** Telegram must confirm the configured owner chat id is
  `private`. That happens either through `getChat` (the dispatcher calls it once
  when a check is pending) or when the owner sends any message to the bot from
  that private chat. Group and channel ids (negative) never qualify.
- **Retries.**
  - A 429 waits Telegram's `retry_after`.
  - Other definite failures back off exponentially with ±25 % jitter, for up to
    6 attempts, then stop for good (`dead`).
  - A blocked bot, an invalid chat, or "message can't be deleted" stops at once.
- **Uncertain sends** are a lost reply, a 5xx, or a worker that stopped
  mid-send (expired lease). Telegram may have accepted the message, so the row is
  marked `dead` with `uncertain:` and **not re-sent**. The owner sees it as
  «غير مؤكد». Exactly-once delivery across that boundary is not claimed.
- **Concurrency.** Claiming uses `FOR UPDATE SKIP LOCKED` plus a 10-minute
  lease, so overlapping dispatchers never get the same row.
- Every schedule runs in `private.tick()` (pg_cron, every minute) on
  Africa/Cairo time. No browser timers are involved.

## The features

| # | Feature | When | Catch-up after an outage |
|---|---|---|---|
| 5 | Scheduled announcement: staff app (in-app + push) or the owner's private chat. Optional auto-removal after publishing (app: 5 min–30 days; Telegram: up to 47 h, because bots can delete only messages under 48 h old). | Cairo local time the owner picks. Times skipped or repeated by daylight saving are refused. | More than 6 h late → marked failed, not sent. |
| 6 | Sunday summary of the previous **closed** Sunday–Saturday week: lateness days, absence days, top 3 on the current month's leaderboard (cumulative green points; ties share a rank). | Sunday at the existing weekly-summary time, once every absence job for that week has run. Replaces the old mid-week summary while on. | Sent until Tuesday, then recorded as skipped. |
| 7 | Payroll summary of the previous month from the existing payroll engine. Shows base salary (as recorded), additions (earned but unpaid reward), deductions, net adjustment, and company totals, in EGP with piastre precision. | From the 1st at the set time, **only once the month is closed**: every absence day processed, no black points awaiting a decision, no missing check-outs (this covers open or overnight shifts on the last day). Until then, a single «لم تكتمل بعد» notice with counts only. | Only the immediately previous month. |
| 8 | Repeated-absence alert: 2 or more consecutive absent working days (the absence job's own rule; Fri/Sat and holidays are skipped; approved leave pauses the streak by default, configurable to "breaks"). | The moment the second absence is recorded (at the absence cutoff). One alert per streak. A correction re-evaluates the streak and records it as invalidated. | Streaks that ended before the feature was switched on are ignored. |

**Identifiers.**
- Payroll reports are `PR-YYYY-MM-vN`.
- A retry with the same figures sends nothing new.
- «إرسال نسخة مصححة» sends v2 only when the figures changed, labelled «تصحيح: النسخة 2 تحل محل النسخة 1».

**Model notes.**
- The app has no per-employee shifts. Working days come from the company's day
  rules.
- The app does not record late *minutes*, so the report says so instead of
  inventing them.
- The payroll model has no "net salary". The report shows the net *adjustment*
  and says the app neither computes net pay nor pays anything.
- This is a single-tenant app: the organisation is the singleton `settings` row,
  and only active owners pass the `svc_*` checks.

## Activation (production)

1. The migrations `20261124090000_owner_bot_reports` and
   `20261124090100_dispatch_owner_chat_check` must be applied, and the
   functions `dispatch`, `telegram-webhook` and `api` deployed. The existing
   secrets `TELEGRAM_BOT_TOKEN` and `VAPID_PRIVATE_KEY` are used; there are no
   new secrets.
2. The owner opens the bot from their own Telegram account and sends `/start`.
   The settings card then shows «تم التحقق».
3. In Settings, turn on the wanted features and press «حفظ». The card shows the
   next Sunday period and the next payroll date.

## Rollback

Turn the features off in Settings: this stops everything immediately, and no
data is touched. A full rollback runs
`supabase/rollback/20261124090000_owner_bot_reports.down.sql`, then
re-applies the earlier definitions of `private.tick`,
`public.svc_claim_outbox` and `private.call_dispatch`.
