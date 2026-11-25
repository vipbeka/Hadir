# Instant owner notifications (Telegram + in-app + device push)

## How it works
Each employee event is saved by a server-side function. That function already
calls `private.enqueue_owner_alert` inside the same transaction:

| Event | Server-side caller | In-app/Telegram text |
|---|---|---|
| Check-in on time | `svc_check_in` → `check_in` | «محمد حضر الساعة 9:04 ص» + date |
| Late check-in | `svc_check_in` → `red_point` | + «⏰ متأخر N دقيقة» |
| Check-in outside the location | (the API refuses it; a record that still lands outside gets a warning line) | «⚠️ تسجيل خارج الموقع المسموح» |
| Check-out | `svc_check_out` → `check_out` | «محمد انصرف الساعة 5:02 م» + duration |
| Absence | `private.run_absence` (every minute via `tick`, at `absence_cutoff`, Cairo) → `black_pending` | «محمد غاب اليوم» |
| Early-departure request | `svc_request_early_leave` | «… طلب انصراف مبكر اليوم الساعة 2:00 م، السبب: …» + submit time |
| Absence/leave request | `svc_request_leave` | «… طلب إجازة (غياب) من … إلى …» |
| Reward request | `svc_request_reward` | «… طلب صرف مكافأة شهر …» |

For these events, `private.owner_fanout` (migration `20261126090000`) does the following:
1. It writes **one** row to `public.owner_notifications`, which feeds the bell, the list and the Realtime toast.
2. It queues **one** Web Push per active owner device (`push_subscriptions`).
3. It queues **one** Telegram message with the same text. The approve/reject buttons for requests are kept, and an «فتح في التطبيق» link button is added.

All three use the same dedupe key, so a retry, a double tap or a re-run of the job never sends anything twice. Sending happens asynchronously in the `dispatch` Edge Function, which runs every minute. A failed send is retried with backoff (up to 6 attempts), and every result stays in `notification_outbox` (shown under Settings → «سجل الإرسال»). If the fan-out itself errors, the error is logged in `job_runs` (`owner_notify`) and the employee's action still succeeds.

## Toggles
`settings.owner_alert_prefs` holds a switch for each type (check_in, check_out, absence, request) and each channel (telegram, app, push). All are on by default. The Telegram switches started from the existing `notify_events`. `owner_alert_channel = 'off'` still turns off all Telegram messages.

## Security
- `owner_notifications` is readable only by the owner (RLS). The owner can update only `read_at`.
- The delivery log and the settings are owner-only. Employees can't read or change them.
- The bot token and the VAPID private key exist only as Edge Function secrets. The chat id is in `settings`, which employees can't read.

## Web Push keys
The VAPID public key is in `web/js/core/push.js` and `supabase/functions/dispatch/index.ts`. Its private key is already set as the Edge Function secret `VAPID_PRIVATE_KEY`; production push deliveries confirm it. **Do not regenerate it**: every existing device subscription would stop working.

Only to rotate the keys on purpose:
```
npx web-push generate-vapid-keys
supabase secrets set VAPID_PRIVATE_KEY=<private key> --project-ref hppcujuplyjkuaxwmjhk
```
Then put the new public key in both files above, redeploy, and have every device enable notifications again.
