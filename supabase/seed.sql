-- Safe first-admin bootstrap.
--
-- 1. Create and verify the user in Supabase Auth.
-- 2. Replace the .invalid address below with that user's exact email.
-- 3. Run this seed once as the database owner, then restore the placeholder.
--
-- With the placeholder unchanged this block intentionally performs no write.

do $$
declare
  target_email constant text := 'REPLACE_WITH_ADMIN_EMAIL@example.invalid';
  target_user auth.users%rowtype;
  existing_admin_id uuid;
  matching_users integer;
begin
  if target_email = 'REPLACE_WITH_ADMIN_EMAIL@example.invalid' then
    raise notice 'Admin promotion skipped: replace the email placeholder first.';
    return;
  end if;

  select count(*)
  into matching_users
  from auth.users
  where lower(email) = lower(target_email);

  if matching_users <> 1 then
    raise exception
      'Expected exactly one Auth user for email %, found %',
      target_email,
      matching_users;
  end if;

  select *
  into strict target_user
  from auth.users
  where lower(email) = lower(target_email);

  select id
  into existing_admin_id
  from public.profiles
  where role = 'admin'
  order by created_at
  limit 1;

  if existing_admin_id is not null and existing_admin_id <> target_user.id then
    raise exception
      'A different admin already exists; use an audited role-management flow.';
  end if;

  insert into public.profiles (id, email, full_name, role)
  values (
    target_user.id,
    target_user.email,
    nullif(btrim(target_user.raw_user_meta_data ->> 'full_name'), ''),
    'admin'
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(excluded.full_name, public.profiles.full_name),
      role = 'admin';

  raise notice 'Promoted % to admin.', target_email;
end;
$$;
