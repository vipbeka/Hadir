# Staff & owner tools (migration `20261127090000_staff_owner_tools`)

| # | Feature | Employee | Owner |
|---|---|---|---|
| 1 | Permission (إذن) — leave for 15 min … N h and come back the same day | «الطلبات» → «طلب إذن»; cancel while pending | «الموافقات» → «الأذونات», or Telegram ✅/❌; over the monthly limit: «قبول مع خصم» (red point) |
| 2 | Personal schedule — personal days off + own hours | home shows «يوم راحتك» | employee page → «جدول الدوام الخاص» |
| 3 | Annual leave balance (work days only; sick leave not counted) | «الطلبات» shows the balance; personal leave beyond it is refused | employee page → «رصيد الإجازات»; default in Settings |
| 4 | Attendance correction (forgot check-in/out, no internet) | «الطلبات» → «تصحيح حضور» | «الموافقات» → «تصحيح الحضور», or Telegram; reject with a reason |
| 5 | Monthly report | — | the employee statement (print / PDF / CSV) now shows personal days off, permissions and the leave balance |
| 6 | Daily summary on Telegram | — | counts first (حاضر · متأخر · غائب · إجازة · راحة), days off, permissions, what waits for a decision |
| 7 | Change log | «كشف حسابي» → «سجل التعديلات» | employee page → «سجل التعديلات» |
| 8 | Check-out overdue reminder | push N minutes after their end time if no check-out | Settings → toggle + minutes |
| 9 | My statement | «كشف حسابي»: deductions, rewards, attendance; salary/net only if allowed | Settings → «إظهار الراتب والصافي المتوقع للموظف» (off by default) |
| 10 | Points goal | «باقي لك N نقطة و M يوم عمل» (or «صعب هذا الشهر») | — |

## Rules
- Permission: within the employee's hours, 15 min … `permission_max_minutes`, no overlap, not on leave / day off.
  An approved permission excuses lateness (no red point) and allows check-in after the window closes
  (until 15 min after it ends); one covering the absence cut-off prevents the absence.
- Over the monthly limit (`permission_monthly_limit`, 0 = none) the request is still sent, marked «فوق الحد».
- Personal day off: never an absence, no reminders, check-in allowed but without points.
  Check-in windows and points stay the same for everyone; own hours drive reminders and the expected check-out.
- A leave request must include at least one work day.
- Corrections use the same rules as the owner's manual correction (points by the corrected time).

## Security
All writes go through `svc_*` functions (service_role only). Employees read only their own requests,
schedule and balance (RLS); they cannot write these tables directly. The change log only lists changes
for the signed-in employee; salary entries appear only when the owner allows it.
