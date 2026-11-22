-- Rollback of 20261122085342_reference_data
delete from public.public_holidays where kind = 'official' and holiday_date between '2026-01-01' and '2027-12-31';
delete from public.check_in_windows;
delete from public.day_rules;
delete from public.settings;
