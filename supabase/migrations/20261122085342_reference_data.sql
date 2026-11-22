-- =====================================================================
-- Zintra حاضر — reference data (confirmed business rules, 2026-11-22)
-- Runs in every environment. Idempotent (on conflict do nothing).
-- =====================================================================

-- Settings singleton: defaults in the table definition match the
-- confirmed rules (Africa/Cairo, office geofence 29.9831944,31.3239444 r=100m,
-- work 09:00–17:00, absence cutoff 11:30, digest 12:00, red 50 EGP with
-- first red a warning, black 1,000 EGP after approval, 30 green = 100 EGP,
-- InstaPay / Vodafone Cash, Telegram chat 1360140225, weekly summary on the
-- last work day 18:00, reminders 15 min).
insert into public.settings (id) values (true) on conflict (id) do nothing;

-- Work week: Sunday–Thursday; Friday & Saturday weekend. (0 = Sunday)
insert into public.day_rules (day_of_week, is_work_day, check_in_enabled, points_enabled) values
  (0, true,  true,  true),
  (1, true,  true,  true),
  (2, true,  true,  true),
  (3, true,  true,  true),
  (4, true,  true,  true),
  (5, false, false, false),
  (6, false, false, false)
on conflict (day_of_week) do nothing;

-- Check-in windows on each work day. Start-inclusive, end-exclusive.
-- 08:00–09:00 is a gap: attendance recorded, no point.
insert into public.check_in_windows (day_of_week, label_ar, label_en, start_time, end_time, enabled, awards_green_point)
select d, w.label_ar, w.label_en, w.s, w.e, true, true
from generate_series(0, 4) as d
cross join (values
  ('مبكر',  'Early',  time '07:00', time '08:00'),
  ('عادي',  'Normal', time '09:00', time '10:00'),
  ('متأخر', 'Late',   time '10:00', time '11:00')
) as w(label_ar, label_en, s, e)
where not exists (select 1 from public.check_in_windows);

-- Egyptian public holidays for 2026 and 2027.
-- Fixed-date holidays are exact. Islamic dates (Eid al-Fitr, Arafat,
-- Eid al-Adha, Islamic New Year, Prophet's Birthday) and Sham El-Nessim
-- are computed in advance from astronomical calendars and the Coptic
-- Easter date; the government confirms them each year and sometimes
-- moves holidays to a Thursday — the owner must review them yearly.
insert into public.public_holidays (holiday_date, name_ar, name_en, kind) values
  -- 2026
  ('2026-01-07', 'عيد الميلاد المجيد',            'Coptic Christmas',               'official'),
  ('2026-01-25', 'عيد الشرطة وثورة 25 يناير',      'Police Day & 25 January Revolution', 'official'),
  ('2026-03-20', 'عيد الفطر (اليوم الأول)',         'Eid al-Fitr (day 1)',            'official'),
  ('2026-03-21', 'عيد الفطر (اليوم الثاني)',        'Eid al-Fitr (day 2)',            'official'),
  ('2026-03-22', 'عيد الفطر (اليوم الثالث)',        'Eid al-Fitr (day 3)',            'official'),
  ('2026-04-13', 'شم النسيم',                      'Sham El-Nessim',                 'official'),
  ('2026-04-25', 'عيد تحرير سيناء',                'Sinai Liberation Day',           'official'),
  ('2026-05-01', 'عيد العمال',                     'Labour Day',                     'official'),
  ('2026-05-26', 'وقفة عرفات',                     'Arafat Day',                     'official'),
  ('2026-05-27', 'عيد الأضحى (اليوم الأول)',        'Eid al-Adha (day 1)',            'official'),
  ('2026-05-28', 'عيد الأضحى (اليوم الثاني)',       'Eid al-Adha (day 2)',            'official'),
  ('2026-05-29', 'عيد الأضحى (اليوم الثالث)',       'Eid al-Adha (day 3)',            'official'),
  ('2026-06-16', 'رأس السنة الهجرية',              'Islamic New Year',               'official'),
  ('2026-06-30', 'ذكرى ثورة 30 يونيو',             '30 June Revolution',             'official'),
  ('2026-07-23', 'عيد ثورة 23 يوليو',              '23 July Revolution Day',         'official'),
  ('2026-08-25', 'المولد النبوي الشريف',           'Prophet''s Birthday',            'official'),
  ('2026-10-06', 'عيد القوات المسلحة',             'Armed Forces Day',               'official'),
  -- 2027
  ('2027-01-07', 'عيد الميلاد المجيد',            'Coptic Christmas',               'official'),
  ('2027-01-25', 'عيد الشرطة وثورة 25 يناير',      'Police Day & 25 January Revolution', 'official'),
  ('2027-03-10', 'عيد الفطر (اليوم الأول)',         'Eid al-Fitr (day 1)',            'official'),
  ('2027-03-11', 'عيد الفطر (اليوم الثاني)',        'Eid al-Fitr (day 2)',            'official'),
  ('2027-03-12', 'عيد الفطر (اليوم الثالث)',        'Eid al-Fitr (day 3)',            'official'),
  ('2027-04-25', 'عيد تحرير سيناء',                'Sinai Liberation Day',           'official'),
  ('2027-05-01', 'عيد العمال',                     'Labour Day',                     'official'),
  ('2027-05-03', 'شم النسيم',                      'Sham El-Nessim',                 'official'),
  ('2027-05-16', 'وقفة عرفات',                     'Arafat Day',                     'official'),
  ('2027-05-17', 'عيد الأضحى (اليوم الأول)',        'Eid al-Adha (day 1)',            'official'),
  ('2027-05-18', 'عيد الأضحى (اليوم الثاني)',       'Eid al-Adha (day 2)',            'official'),
  ('2027-05-19', 'عيد الأضحى (اليوم الثالث)',       'Eid al-Adha (day 3)',            'official'),
  ('2027-06-06', 'رأس السنة الهجرية',              'Islamic New Year',               'official'),
  ('2027-06-30', 'ذكرى ثورة 30 يونيو',             '30 June Revolution',             'official'),
  ('2027-07-23', 'عيد ثورة 23 يوليو',              '23 July Revolution Day',         'official'),
  ('2027-08-15', 'المولد النبوي الشريف',           'Prophet''s Birthday',            'official'),
  ('2027-10-06', 'عيد القوات المسلحة',             'Armed Forces Day',               'official')
on conflict (holiday_date) do nothing;
