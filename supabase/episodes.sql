-- In Good Company editor · shared episodes (run once, after setup.sql)
-- Supabase dashboard → SQL Editor → New query → paste → Run.
-- Stores each shared episode's edit (cuts, titles, lower thirds, order…) — never the videos.

create table if not exists public.episodes (
  id          text primary key,
  name        text not null default '',
  data        jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  editing_by  text,
  editing_at  timestamptz
);

alter table public.episodes enable row level security;

drop policy if exists "igc episodes: company only" on public.episodes;
create policy "igc episodes: company only" on public.episodes
  for all to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@meetelise.com')
  with check (lower(auth.jwt() ->> 'email') like '%@meetelise.com');

grant select, insert, update, delete on public.episodes to authenticated;
