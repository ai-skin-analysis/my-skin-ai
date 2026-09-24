-- Smart Skin AI: private application data restored from the legacy Flask shape.
-- Run this in Supabase Dashboard > SQL Editor after creating the free project.
-- The browser never receives the service-role key. Vercel functions use it
-- server-side and enforce the existing signed application session first.

create extension if not exists pgcrypto;

create table if not exists public.smart_skin_scan_logs (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null,
  image_object_path text,
  gradcam_object_path text,
  result_disease text,
  confidence text,
  created_at timestamptz not null default now(),
  consented_at timestamptz not null default now(),
  consent_version text not null default 'web-v1',
  retention_expires_at timestamptz not null,
  top_predictions jsonb not null default '[]'::jsonb,
  is_uncertain boolean not null default true,
  decision_status text not null default 'preview_only',
  model_version text,
  check (char_length(coalesce(result_disease, '')) <= 300),
  check (char_length(coalesce(confidence, '')) <= 32)
);

create index if not exists smart_skin_scan_logs_user_created_idx
  on public.smart_skin_scan_logs (user_id, created_at desc);
create index if not exists smart_skin_scan_logs_expiry_idx
  on public.smart_skin_scan_logs (retention_expires_at);

create table if not exists public.smart_skin_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null,
  topic text not null default 'general',
  message text not null,
  created_at timestamptz not null default now(),
  retention_expires_at timestamptz not null,
  check (topic in ('general', 'privacy', 'account', 'technical')),
  check (char_length(message) between 1 and 2000)
);

create index if not exists smart_skin_feedback_created_idx
  on public.smart_skin_feedback (created_at desc);
create index if not exists smart_skin_feedback_expiry_idx
  on public.smart_skin_feedback (retention_expires_at);

create table if not exists public.smart_skin_nearby_context (
  user_id bigint primary key,
  latitude_approx numeric(7,4) not null,
  longitude_approx numeric(7,4) not null,
  pm25 numeric(7,2) not null,
  uv_index numeric(5,2) not null,
  relative_humidity numeric(5,2) not null,
  temperature_c numeric(5,2) not null,
  context_level text not null default 'ข้อมูลทั่วไป',
  context_summary text not null,
  consented_at timestamptz not null default now(),
  retention_expires_at timestamptz not null,
  check (latitude_approx between -90 and 90),
  check (longitude_approx between -180 and 180),
  check (pm25 between 0 and 1000),
  check (uv_index between 0 and 30),
  check (relative_humidity between 0 and 100),
  check (temperature_c between -90 and 70)
);

create index if not exists smart_skin_nearby_context_expiry_idx
  on public.smart_skin_nearby_context (retention_expires_at);

create table if not exists public.smart_skin_profile_avatars (
  user_id bigint primary key,
  object_path text not null unique,
  updated_at timestamptz not null default now(),
  retention_expires_at timestamptz
);

-- Health images and profile photos are private. No anonymous or authenticated
-- browser role has a policy; only the Vercel backend service key can read them.
alter table public.smart_skin_scan_logs enable row level security;
alter table public.smart_skin_feedback enable row level security;
alter table public.smart_skin_nearby_context enable row level security;
alter table public.smart_skin_profile_avatars enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'smart-skin-private',
  'smart-skin-private',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Do not add public storage policies. The Vercel backend creates short-lived,
-- authorised access only after it verifies the current signed session.
