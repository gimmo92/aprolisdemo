-- Precomputed exploded drawings. PDFs are ingestion inputs only: runtime clients
-- receive sanitized SVG/PNG assets and JSON callout geometry.

create table if not exists public.exploded_views (
  id uuid primary key,
  catalog_id uuid not null references public.catalogs (id) on delete cascade,
  machine text not null,
  figure_code text not null,
  title text not null,
  page_index integer not null,
  parts_pages integer[] not null default '{}',
  svg_path text not null,
  asset_type text not null default 'svg',
  view_w double precision not null,
  view_h double precision not null,
  trace_rate double precision not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exploded_views_machine_not_blank check (btrim(machine) <> ''),
  constraint exploded_views_figure_not_blank check (btrim(figure_code) <> ''),
  constraint exploded_views_title_not_blank check (btrim(title) <> ''),
  constraint exploded_views_page_positive check (page_index > 0),
  constraint exploded_views_dimensions_positive check (view_w > 0 and view_h > 0),
  constraint exploded_views_trace_rate check (trace_rate between 0 and 1),
  constraint exploded_views_asset_type check (asset_type in ('svg', 'png')),
  constraint exploded_views_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint exploded_views_catalog_figure_key unique (catalog_id, figure_code)
);

create index if not exists exploded_views_catalog_machine_idx
  on public.exploded_views (catalog_id, machine);

create table if not exists public.exploded_callouts (
  id uuid primary key,
  view_id uuid not null references public.exploded_views (id) on delete cascade,
  label text not null,
  items numeric[] not null,
  x double precision not null,
  y double precision not null,
  tip_x double precision not null,
  tip_y double precision not null,
  traced boolean not null default false,
  created_at timestamptz not null default now(),
  constraint exploded_callouts_label_not_blank check (btrim(label) <> ''),
  constraint exploded_callouts_items_not_empty check (cardinality(items) > 0)
);

create index if not exists exploded_callouts_view_idx
  on public.exploded_callouts (view_id);

drop trigger if exists exploded_views_set_updated_at on public.exploded_views;
create trigger exploded_views_set_updated_at
before update on public.exploded_views
for each row execute function public.set_updated_at();

alter table public.exploded_views enable row level security;
alter table public.exploded_callouts enable row level security;

create policy exploded_views_select_ready_or_admin
on public.exploded_views for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.catalogs
    where catalogs.id = exploded_views.catalog_id
      and catalogs.status = 'ready'
  )
);

create policy exploded_views_admin_all
on public.exploded_views for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy exploded_callouts_select_ready_or_admin
on public.exploded_callouts for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.exploded_views ev
    join public.catalogs c on c.id = ev.catalog_id
    where ev.id = exploded_callouts.view_id
      and c.status = 'ready'
  )
);

create policy exploded_callouts_admin_all
on public.exploded_callouts for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, insert, update, delete on table public.exploded_views to authenticated;
grant select, insert, update, delete on table public.exploded_callouts to authenticated;
grant all on table public.exploded_views to service_role;
grant all on table public.exploded_callouts to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'exploded-views',
  'exploded-views',
  false,
  20971520,
  array['image/svg+xml', 'image/png']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy exploded_assets_admin_select
on storage.objects for select
to authenticated
using (bucket_id = 'exploded-views' and public.is_admin());

create policy exploded_assets_admin_insert
on storage.objects for insert
to authenticated
with check (bucket_id = 'exploded-views' and public.is_admin());

create policy exploded_assets_admin_update
on storage.objects for update
to authenticated
using (bucket_id = 'exploded-views' and public.is_admin())
with check (bucket_id = 'exploded-views' and public.is_admin());

create policy exploded_assets_admin_delete
on storage.objects for delete
to authenticated
using (bucket_id = 'exploded-views' and public.is_admin());

create or replace function public.replace_catalog_exploded_views(
  p_catalog_id uuid,
  p_views jsonb,
  p_callouts jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if jsonb_typeof(p_views) <> 'array' or jsonb_typeof(p_callouts) <> 'array' then
    raise exception 'views and callouts must be JSON arrays';
  end if;

  delete from public.exploded_views where catalog_id = p_catalog_id;

  insert into public.exploded_views (
    id, catalog_id, machine, figure_code, title, page_index, parts_pages,
    svg_path, asset_type, view_w, view_h, trace_rate, metadata
  )
  select
    r.id,
    p_catalog_id,
    r.machine,
    r.figure_code,
    r.title,
    r.page_index,
    coalesce(r.parts_pages, '{}'),
    r.svg_path,
    coalesce(nullif(r.asset_type, ''), 'svg'),
    r.view_w,
    r.view_h,
    r.trace_rate,
    coalesce(r.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_views) as r (
    id uuid,
    machine text,
    figure_code text,
    title text,
    page_index integer,
    parts_pages integer[],
    svg_path text,
    asset_type text,
    view_w double precision,
    view_h double precision,
    trace_rate double precision,
    metadata jsonb
  );

  get diagnostics inserted_count = row_count;

  insert into public.exploded_callouts (
    id, view_id, label, items, x, y, tip_x, tip_y, traced
  )
  select
    r.id,
    r.view_id,
    r.label,
    r.items,
    r.x,
    r.y,
    r.tip_x,
    r.tip_y,
    r.traced
  from jsonb_to_recordset(p_callouts) as r (
    id uuid,
    view_id uuid,
    label text,
    items numeric[],
    x double precision,
    y double precision,
    tip_x double precision,
    tip_y double precision,
    traced boolean
  );

  return inserted_count;
end;
$$;

revoke all on function public.replace_catalog_exploded_views(uuid, jsonb, jsonb)
  from public;
grant execute on function public.replace_catalog_exploded_views(uuid, jsonb, jsonb)
  to service_role;
