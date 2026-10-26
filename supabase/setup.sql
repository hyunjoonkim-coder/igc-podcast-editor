-- In Good Company editor · Supabase setup
-- Run once: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Creates a PRIVATE bucket for the team's brand files (intro/outro videos, music, logo…).
-- Only signed-in accounts on the company domain can read or change them.

insert into storage.buckets (id, name, public)
values ('brand', 'brand', false)
on conflict (id) do update set public = false;

drop policy if exists "igc brand: company can read"   on storage.objects;
drop policy if exists "igc brand: company can add"    on storage.objects;
drop policy if exists "igc brand: company can change" on storage.objects;
drop policy if exists "igc brand: company can delete" on storage.objects;

create policy "igc brand: company can read" on storage.objects
  for select to authenticated
  using (bucket_id = 'brand' and lower(auth.jwt() ->> 'email') like '%@meetelise.com');

create policy "igc brand: company can add" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'brand' and lower(auth.jwt() ->> 'email') like '%@meetelise.com');

create policy "igc brand: company can change" on storage.objects
  for update to authenticated
  using (bucket_id = 'brand' and lower(auth.jwt() ->> 'email') like '%@meetelise.com')
  with check (bucket_id = 'brand' and lower(auth.jwt() ->> 'email') like '%@meetelise.com');

create policy "igc brand: company can delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'brand' and lower(auth.jwt() ->> 'email') like '%@meetelise.com');
