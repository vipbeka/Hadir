# Egyptian public holidays 2027 — sources and status

Retrieved: 2026-11-23. No official Cabinet decree for 2027 had been published
at that date; the Islamic (Hijri) dates depend on Dar al-Ifta's moon sighting
and may move by a day. A mid-week holiday may also be moved to a Thursday by a
Cabinet decision.

| Date | Holiday | Status in the app |
|---|---|---|
| 07/01/2027 | Coptic Christmas | confirmed (fixed date) |
| 25/01/2027 | Police Day & 25 January Revolution | confirmed (fixed date) |
| 10–12/03/2027 | Eid al-Fitr (3 days) | **provisional** (sources say 9 or 10 March) |
| 25/04/2027 | Sinai Liberation Day | confirmed (fixed date) |
| 01/05/2027 | Labour Day | confirmed (fixed date) |
| 03/05/2027 | Sham El-Nessim | confirmed (day after Orthodox Easter, 2 May 2027) |
| 16/05/2027 | Arafat Day | **provisional** (sources say 15 or 16 May) |
| 17–19/05/2027 | Eid al-Adha (3 days) | **provisional** (sources say 16 or 17 May) |
| 06/06/2027 | Islamic New Year | **provisional** |
| 30/06/2027 | 30 June Revolution | confirmed (fixed date) |
| 23/07/2027 | 23 July Revolution Day | confirmed (fixed date) |
| 15/08/2027 | Prophet's Birthday | **provisional** (sources say 14 or 15 August) |
| 06/10/2027 | Armed Forces Day | confirmed (fixed date) |

Database effect (migration `20261123120000_late_red_windows_announcements`):
all 17 rows already existed, so the idempotent insert (`on conflict do
nothing`) inserted 0 rows and preserved every existing row. 9 official lunar
rows were marked `provisional = true` (still enabled, so nobody is marked
absent on an Eid); 8 fixed-date rows got `source_note = 'fixed date'`. No
company or owner-edited holiday was changed. The owner confirms a date with
«تأكيد التاريخ» on the holidays page once it is announced.

Sources (news and calendar sites; no government page was available yet):
- https://www.egyin.com/article/161650/
- https://ahlmasrnews.com/news/egypt-news/13504188/
- https://ahlmasrnews.com/news/services/13499947/
- https://shofnews.com/159744/
- https://www.timeanddate.com/holidays/egypt/2027
- https://www.gulftalent.com/egypt/resources/public-holidays/2027
- https://www.qppstudio.net/public-holidays/egypt.htm
