-- Rollback of 20261123035413_leaderboard_scopes
drop function if exists public.get_leaderboard(text);
