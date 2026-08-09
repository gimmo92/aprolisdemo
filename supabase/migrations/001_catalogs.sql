-- Supabase bootstrap for private catalog ingestion and serial-scoped part search.

create extension if not exists pgcrypto with schema extensions;

do $$
begin
  create type public.profile_role as enum ('admin', 'viewer');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.catalog_status as enum (
    'uploaded',
    'processing',
    'ready',
    'needs_review',
    'failed'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.ingestion_job_status as enum (
    'queued',
    'running',
    'completed',
    'failed'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  role public.profile_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_not_blank check (email is null or btrim(email) <> '')
);

create unique index if not exists profiles_email_uidx
  on public.profiles (lower(email))
  where email is not null;

create table if not exists public.catalogs (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  model text not null,
  version text,
  customer text,
  order_reference text,
  original_filename text not null,
  mime_type text not null default 'application/pdf',
  file_size bigint,
  page_count integer,
  part_count integer not null default 0,
  storage_path text not null,
  status public.catalog_status not null default 'uploaded',
  checksum_sha256 text,
  revision text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid()
    references public.profiles (id) on delete restrict,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalogs_brand_not_blank check (btrim(brand) <> ''),
  constraint catalogs_model_not_blank check (btrim(model) <> ''),
  constraint catalogs_filename_not_blank check (btrim(original_filename) <> ''),
  constraint catalogs_storage_path_not_blank check (btrim(storage_path) <> ''),
  constraint catalogs_storage_path_relative check (
    storage_path !~ '(^/|(^|/)\.\.?(/|$))'
  ),
  constraint catalogs_revision_not_blank check (
    revision is null or btrim(revision) <> ''
  ),
  constraint catalogs_file_size_nonnegative check (
    file_size is null or file_size >= 0
  ),
  constraint catalogs_page_count_positive check (
    page_count is null or page_count > 0
  ),
  constraint catalogs_part_count_nonnegative check (part_count >= 0),
  constraint catalogs_checksum_sha256_format check (
    checksum_sha256 is null or checksum_sha256 ~ '^[0-9A-Fa-f]{64}$'
  ),
  constraint catalogs_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint catalogs_storage_path_key unique (storage_path)
);

create unique index if not exists catalogs_checksum_sha256_uidx
  on public.catalogs (lower(checksum_sha256))
  where checksum_sha256 is not null;

create unique index if not exists catalogs_document_revision_uidx
  on public.catalogs (
    lower(original_filename),
    lower(coalesce(revision, ''))
  );

create index if not exists catalogs_status_idx
  on public.catalogs (status, updated_at desc);

create index if not exists catalogs_created_by_idx
  on public.catalogs (created_by);

create table if not exists public.catalog_serials (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.catalogs (id) on delete cascade,
  serial_number text not null,
  normalized_serial text generated always as (
    upper(regexp_replace(btrim(serial_number), '[^A-Za-z0-9]', '', 'g'))
  ) stored,
  label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_serials_serial_not_blank check (btrim(serial_number) <> ''),
  constraint catalog_serials_normalized_not_blank check (normalized_serial <> ''),
  constraint catalog_serials_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint catalog_serials_catalog_normalized_key
    unique (catalog_id, normalized_serial)
);

create index if not exists catalog_serials_normalized_idx
  on public.catalog_serials (normalized_serial, catalog_id);

create table if not exists public.parts (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.catalogs (id) on delete cascade,
  code text not null,
  description text not null,
  original_description text,
  quantity numeric(12, 3),
  item text,
  page_number integer not null,
  category text,
  assembly_code text,
  assembly_title text,
  source_type text not null default 'generic',
  confidence numeric(4, 3),
  bbox jsonb,
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple'::regconfig, coalesce(code, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(description, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(original_description, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(item, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(category, '')), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(assembly_code, '')), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(assembly_title, '')), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint parts_code_not_blank check (btrim(code) <> ''),
  constraint parts_description_not_blank check (btrim(description) <> ''),
  constraint parts_quantity_nonnegative check (quantity is null or quantity >= 0),
  constraint parts_page_positive check (page_number > 0),
  constraint parts_source_type_not_blank check (btrim(source_type) <> ''),
  constraint parts_confidence_range check (
    confidence is null or confidence between 0 and 1
  ),
  constraint parts_bbox_array check (
    bbox is null or jsonb_typeof(bbox) = 'array'
  ),
  constraint parts_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists parts_catalog_identity_uidx
  on public.parts (
    catalog_id,
    lower(code),
    page_number,
    lower(coalesce(item, ''))
  );

create index if not exists parts_catalog_idx
  on public.parts (catalog_id);

create index if not exists parts_search_vector_gin_idx
  on public.parts using gin (search_vector);

create table if not exists public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.catalogs (id) on delete cascade,
  status public.ingestion_job_status not null default 'queued',
  stage text,
  progress smallint not null default 0,
  processed_items integer not null default 0,
  total_items integer,
  error_message text,
  error_details jsonb,
  report jsonb,
  triggered_by uuid default auth.uid()
    references public.profiles (id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_jobs_progress_range check (progress between 0 and 100),
  constraint ingestion_jobs_processed_nonnegative check (processed_items >= 0),
  constraint ingestion_jobs_total_nonnegative check (
    total_items is null or total_items >= 0
  ),
  constraint ingestion_jobs_processed_within_total check (
    total_items is null or processed_items <= total_items
  ),
  constraint ingestion_jobs_error_details_object check (
    error_details is null or jsonb_typeof(error_details) = 'object'
  ),
  constraint ingestion_jobs_report_object check (
    report is null or jsonb_typeof(report) = 'object'
  ),
  constraint ingestion_jobs_completed_after_started check (
    completed_at is null or started_at is null or completed_at >= started_at
  )
);

create unique index if not exists ingestion_jobs_one_active_per_catalog_uidx
  on public.ingestion_jobs (catalog_id)
  where status in ('queued', 'running');

create index if not exists ingestion_jobs_catalog_created_idx
  on public.ingestion_jobs (catalog_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists catalogs_set_updated_at on public.catalogs;
create trigger catalogs_set_updated_at
before update on public.catalogs
for each row execute function public.set_updated_at();

drop trigger if exists catalog_serials_set_updated_at on public.catalog_serials;
create trigger catalog_serials_set_updated_at
before update on public.catalog_serials
for each row execute function public.set_updated_at();

drop trigger if exists parts_set_updated_at on public.parts;
create trigger parts_set_updated_at
before update on public.parts
for each row execute function public.set_updated_at();

drop trigger if exists ingestion_jobs_set_updated_at on public.ingestion_jobs;
create trigger ingestion_jobs_set_updated_at
before update on public.ingestion_jobs
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    'viewer'
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(excluded.full_name, public.profiles.full_name);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, service_role;

alter table public.profiles enable row level security;
alter table public.catalogs enable row level security;
alter table public.catalog_serials enable row level security;
alter table public.parts enable row level security;
alter table public.ingestion_jobs enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin
on public.profiles for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
on public.profiles for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists catalogs_select_ready_or_admin on public.catalogs;
create policy catalogs_select_ready_or_admin
on public.catalogs for select
to authenticated
using (status = 'ready' or public.is_admin());

drop policy if exists catalogs_insert_admin on public.catalogs;
create policy catalogs_insert_admin
on public.catalogs for insert
to authenticated
with check (public.is_admin() and created_by = auth.uid());

drop policy if exists catalogs_update_admin on public.catalogs;
create policy catalogs_update_admin
on public.catalogs for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists catalogs_delete_admin on public.catalogs;
create policy catalogs_delete_admin
on public.catalogs for delete
to authenticated
using (public.is_admin());

drop policy if exists catalog_serials_select_ready_or_admin on public.catalog_serials;
create policy catalog_serials_select_ready_or_admin
on public.catalog_serials for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.catalogs
    where catalogs.id = catalog_serials.catalog_id
      and catalogs.status = 'ready'
  )
);

drop policy if exists catalog_serials_insert_admin on public.catalog_serials;
create policy catalog_serials_insert_admin
on public.catalog_serials for insert
to authenticated
with check (public.is_admin());

drop policy if exists catalog_serials_update_admin on public.catalog_serials;
create policy catalog_serials_update_admin
on public.catalog_serials for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists catalog_serials_delete_admin on public.catalog_serials;
create policy catalog_serials_delete_admin
on public.catalog_serials for delete
to authenticated
using (public.is_admin());

drop policy if exists parts_select_ready_or_admin on public.parts;
create policy parts_select_ready_or_admin
on public.parts for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.catalogs
    where catalogs.id = parts.catalog_id
      and catalogs.status = 'ready'
  )
);

drop policy if exists parts_insert_admin on public.parts;
create policy parts_insert_admin
on public.parts for insert
to authenticated
with check (public.is_admin());

drop policy if exists parts_update_admin on public.parts;
create policy parts_update_admin
on public.parts for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists parts_delete_admin on public.parts;
create policy parts_delete_admin
on public.parts for delete
to authenticated
using (public.is_admin());

drop policy if exists ingestion_jobs_admin_all on public.ingestion_jobs;
create policy ingestion_jobs_admin_all
on public.ingestion_jobs for all
to authenticated
using (public.is_admin())
with check (
  public.is_admin()
  and (triggered_by is null or triggered_by = auth.uid())
);

revoke all on table public.profiles from anon;
revoke all on table public.catalogs from anon;
revoke all on table public.catalog_serials from anon;
revoke all on table public.parts from anon;
revoke all on table public.ingestion_jobs from anon;

grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.catalogs to authenticated;
grant select, insert, update, delete on table public.catalog_serials to authenticated;
grant select, insert, update, delete on table public.parts to authenticated;
grant select, insert, update, delete on table public.ingestion_jobs to authenticated;

grant all on table public.profiles to service_role;
grant all on table public.catalogs to service_role;
grant all on table public.catalog_serials to service_role;
grant all on table public.parts to service_role;
grant all on table public.ingestion_jobs to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'catalogs',
  'catalogs',
  false,
  262144000,
  array['application/pdf']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists catalogs_objects_select_admin on storage.objects;
create policy catalogs_objects_select_admin
on storage.objects for select
to authenticated
using (bucket_id = 'catalogs' and public.is_admin());

drop policy if exists catalogs_objects_insert_admin on storage.objects;
create policy catalogs_objects_insert_admin
on storage.objects for insert
to authenticated
with check (bucket_id = 'catalogs' and public.is_admin());

drop policy if exists catalogs_objects_update_admin on storage.objects;
create policy catalogs_objects_update_admin
on storage.objects for update
to authenticated
using (bucket_id = 'catalogs' and public.is_admin())
with check (bucket_id = 'catalogs' and public.is_admin());

drop policy if exists catalogs_objects_delete_admin on storage.objects;
create policy catalogs_objects_delete_admin
on storage.objects for delete
to authenticated
using (bucket_id = 'catalogs' and public.is_admin());

drop function if exists public.catalog_for_serial(text);
create function public.catalog_for_serial(p_serial text)
returns table (
  id uuid,
  brand text,
  model text,
  version text,
  customer text,
  order_reference text,
  original_filename text,
  revision text,
  page_count integer,
  part_count integer,
  status public.catalog_status,
  metadata jsonb,
  updated_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.brand,
    c.model,
    c.version,
    c.customer,
    c.order_reference,
    c.original_filename,
    c.revision,
    c.page_count,
    c.part_count,
    c.status,
    c.metadata,
    c.updated_at
  from public.catalog_serials cs
  join public.catalogs c on c.id = cs.catalog_id
  where cs.normalized_serial = upper(
    regexp_replace(btrim(coalesce(p_serial, '')), '[^A-Za-z0-9]', '', 'g')
  )
    and c.status = 'ready'
  order by c.processed_at desc nulls last, c.updated_at desc
  limit 1;
$$;

drop function if exists public.search_parts(text, text, integer, integer);
create function public.search_parts(
  p_serial text,
  p_query text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  catalog_id uuid,
  code text,
  description text,
  original_description text,
  quantity numeric,
  item text,
  page_number integer,
  category text,
  assembly_code text,
  assembly_title text,
  source_type text,
  rank real
)
language sql
stable
set search_path = ''
as $$
  with selected_catalog as (
    select c.id
    from public.catalog_serials cs
    join public.catalogs c on c.id = cs.catalog_id
    where cs.normalized_serial = upper(
      regexp_replace(btrim(coalesce(p_serial, '')), '[^A-Za-z0-9]', '', 'g')
    )
      and c.status = 'ready'
    order by c.processed_at desc nulls last, c.updated_at desc
    limit 1
  ),
  query as (
    select websearch_to_tsquery('simple'::regconfig, coalesce(p_query, '')) as value
  )
  select
    p.id,
    p.catalog_id,
    p.code,
    p.description,
    p.original_description,
    p.quantity,
    p.item,
    p.page_number,
    p.category,
    p.assembly_code,
    p.assembly_title,
    p.source_type,
    ts_rank(p.search_vector, query.value) as rank
  from public.parts p
  join selected_catalog c on c.id = p.catalog_id
  cross join query
  where nullif(btrim(coalesce(p_query, '')), '') is not null
    and p.search_vector @@ query.value
  order by rank desc, p.code, p.page_number
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.list_parts(text, integer, integer);
create function public.list_parts(
  p_serial text,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  catalog_id uuid,
  code text,
  description text,
  original_description text,
  quantity numeric,
  item text,
  page_number integer,
  category text,
  assembly_code text,
  assembly_title text,
  source_type text
)
language sql
stable
set search_path = ''
as $$
  with selected_catalog as (
    select c.id
    from public.catalog_serials cs
    join public.catalogs c on c.id = cs.catalog_id
    where cs.normalized_serial = upper(
      regexp_replace(btrim(coalesce(p_serial, '')), '[^A-Za-z0-9]', '', 'g')
    )
      and c.status = 'ready'
    order by c.processed_at desc nulls last, c.updated_at desc
    limit 1
  )
  select
    p.id,
    p.catalog_id,
    p.code,
    p.description,
    p.original_description,
    p.quantity,
    p.item,
    p.page_number,
    p.category,
    p.assembly_code,
    p.assembly_title,
    p.source_type
  from public.parts p
  join selected_catalog c on c.id = p.catalog_id
  order by
    p.page_number,
    p.item nulls last,
    p.code
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.catalog_for_serial(text) from public;
revoke all on function public.search_parts(text, text, integer, integer) from public;
revoke all on function public.list_parts(text, integer, integer) from public;

grant execute on function public.catalog_for_serial(text)
  to authenticated, service_role;
grant execute on function public.search_parts(text, text, integer, integer)
  to authenticated, service_role;
grant execute on function public.list_parts(text, integer, integer)
  to authenticated, service_role;

-- Service-only atomic replacement used by the indexer. Any validation or
-- insert failure rolls the whole function back, preserving the previous index.
create or replace function public.replace_catalog_parts(
  p_catalog_id uuid,
  p_rows jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) > 100000 then
    raise exception 'too many part rows';
  end if;

  delete from public.parts where catalog_id = p_catalog_id;
  insert into public.parts (
    catalog_id,
    code,
    description,
    original_description,
    quantity,
    item,
    page_number,
    category,
    assembly_code,
    assembly_title,
    source_type,
    confidence,
    bbox,
    metadata
  )
  select
    p_catalog_id,
    row.code,
    row.description,
    row.original_description,
    row.quantity,
    nullif(row.item, ''),
    row.page_number,
    row.category,
    nullif(row.assembly_code, ''),
    nullif(row.assembly_title, ''),
    coalesce(nullif(row.source_type, ''), 'generic'),
    row.confidence,
    row.bbox,
    coalesce(row.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_rows) as row (
    code text,
    description text,
    original_description text,
    quantity numeric,
    item text,
    page_number integer,
    category text,
    assembly_code text,
    assembly_title text,
    source_type text,
    confidence numeric,
    bbox jsonb,
    metadata jsonb
  );

  get diagnostics inserted_count = row_count;
  update public.catalogs
  set part_count = inserted_count
  where id = p_catalog_id;
  return inserted_count;
end;
$$;

revoke all on function public.replace_catalog_parts(uuid, jsonb) from public;
grant execute on function public.replace_catalog_parts(uuid, jsonb) to service_role;
