-- =====================================================================
-- Zintra حاضر — leaderboard tabs: this month / previous month / all time.
-- Same safe columns as get_leaderboard() (rank, names, job title, GREEN
-- total, threshold, is_me) — never red/black/deductions. Additive: the
-- original zero-argument function is left untouched.
-- =====================================================================
create or replace function public.get_leaderboard(p_scope text)
returns table (rank int, full_name_ar text, full_name_en text, job_title_ar text, job_title_en text,
               green int, threshold int, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.current_uid(); s public.settings := private.settings();
  v_period date := private.period_of(private.local_now()::date);
begin
  if v_uid is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(p_scope, 'month') not in ('month', 'prev', 'all') then perform private.err('invalid_scope'); end if;
  if not s.leaderboard_visible and not private.is_owner() then return; end if;
  if p_scope = 'prev' then v_period := (v_period - interval '1 month')::date; end if;
  return query
    select (rank() over (order by g.green desc))::int, g.full_name_ar, g.full_name_en, g.job_title_ar, g.job_title_en,
           g.green, s.green_reward_threshold, g.id = v_uid
    from (select p.id, p.full_name_ar, p.full_name_en, p.job_title_ar, p.job_title_en,
                 greatest(case when p_scope = 'all'
                   then (select coalesce(sum(e.delta), 0)::int from public.point_events e
                          where e.employee_id = p.id and e.color = 'green' and e.status = 'active')
                   else private.period_total(p.id, 'green', v_period) end, 0) as green
          from public.profiles p where p.role = 'staff' and p.active) g
    order by g.green desc, g.full_name_en;
end $$;
revoke all on function public.get_leaderboard(text) from public, anon;
grant execute on function public.get_leaderboard(text) to authenticated, service_role;
