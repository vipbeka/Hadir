-- Local development seed (runs on `supabase db reset`).
-- Reference data (settings, day rules, windows, 2026–2027 holidays) is in
-- the reference_data migration so every environment gets it.
-- People + login codes are NOT created here: codes must be generated and
-- hashed by the Edge Function and handed over once. For local dev run:
--   node tools/bootstrap/prepare.mjs owner        (then call /functions/v1/bootstrap)
--   node tools/bootstrap/prepare.mjs seed_staff   (three demo staff)
-- See README → "Initial owner code".
select 1;
