# Supabase Free setup for Smart Skin AI

This folder restores the data services used by the legacy Flask application
without exposing private skin images directly to the browser.

## One-time dashboard setup

1. Create a **Free** project at https://supabase.com/dashboard.
2. Open **SQL Editor**, paste and run
   `supabase/migrations/20260924_restore_legacy_features.sql`.
3. From **Project Settings → API**, copy the project URL.
4. From **Project Settings → API keys**, create or copy a server-side
   `sb_secret_...` key. Do not put this key in source code or send it in chat.
5. In **Vercel → Smart Skin AI → Settings → Environment Variables**, create:
   - `SUPABASE_URL` = project URL
   - `SUPABASE_SECRET_KEY` = secret key (Production only)
   - Optional: `SMART_SKIN_SCAN_RETENTION_DAYS` = `30` (allowed range 1–365)

The existing login system stays in place. This avoids copying legacy password
hashes, and the Vercel backend uses the current account ID to scope all private
records. The legacy SQLite database has no historic scan, feedback, location,
or avatar records to migrate.

The migration explicitly grants only `service_role` access to the data tables
and enables RLS with no browser policies. This is required for Supabase projects
created after the Data API default-privileges change. Do not grant these tables
to `anon` or `authenticated` because the Vercel server is the sole data client.

## What moves to Supabase

New profile avatars and consented scan images go to the private Storage bucket.
Their records, user scan history, feedback, and the latest consented coarse
nearby-environment context go to Supabase tables. Images are re-encoded in the
browser before upload, so common image metadata such as EXIF/GPS is not sent.
The existing signed account session remains the access control layer; the
service-role key stays only in Vercel server functions.

The old 6-class TensorFlow model is deliberately not connected: it is not a
validated 50-class release, so storing an image is not a medical diagnosis.
