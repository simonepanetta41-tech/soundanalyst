-- Contatore d'uso atomico — risolve la race condition del rate limit.
-- Prima: le funzioni leggevano analyses_count e poi scrivevano count+1.
-- Due richieste in parallelo leggevano lo stesso valore e passavano entrambe.
-- Qui lettura e incremento avvengono in un'unica istruzione atomica.
--
-- Eseguire nel SQL editor di Supabase. Risposta attesa: "Success. No rows returned".

-- Vincolo necessario per ON CONFLICT (se non esiste già)
create unique index if not exists usage_limits_user_date_uidx
  on public.usage_limits (user_id, date);

create or replace function public.consume_analysis_quota(
  p_user_id uuid,
  p_date    date,
  p_limit   int
)
returns table (allowed boolean, new_count int, plan text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan       text;
  v_permanent  text;
  v_count      int;
  v_limit      int;
begin
  -- Piano permanente (founder) — indipendente dalla riga del giorno
  select ul.permanent_plan into v_permanent
  from usage_limits ul
  where ul.user_id = p_user_id and ul.permanent_plan is not null
  limit 1;

  -- Crea o blocca la riga di oggi in modo atomico
  insert into usage_limits (user_id, date, analyses_count, plan)
  values (p_user_id, p_date, 0, 'free')
  on conflict (user_id, date) do nothing;

  select ul.analyses_count, ul.plan into v_count, v_plan
  from usage_limits ul
  where ul.user_id = p_user_id and ul.date = p_date
  for update;              -- lock di riga: serializza le richieste concorrenti

  if v_permanent = 'founder' then
    update usage_limits
       set analyses_count = v_count + 1
     where user_id = p_user_id and date = p_date;
    return query select true, v_count + 1, 'founder'::text;
    return;
  end if;

  v_limit := coalesce(p_limit, 3);

  if v_count >= v_limit then
    return query select false, v_count, coalesce(v_plan, 'free')::text;
    return;
  end if;

  update usage_limits
     set analyses_count = v_count + 1
   where user_id = p_user_id and date = p_date;

  return query select true, v_count + 1, coalesce(v_plan, 'free')::text;
end;
$$;

revoke all on function public.consume_analysis_quota(uuid, date, int) from public, anon;
grant execute on function public.consume_analysis_quota(uuid, date, int) to service_role;
