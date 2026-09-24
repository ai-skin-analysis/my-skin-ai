# Supabase Free setup for Smart Skin AI

This folder restores the data services used by the legacy Flask application
without exposing private skin images directly to the browser.

## One-time dashboard setup

1. Create a **Free** project at https://supabase.com/dashboard.
2. Open **SQL Editor**, paste and run
   `supabase/migrations/20260924_restore_legacy_features.sql`.
3. From **Project Settings → API**, copy the project URL.
4. From **Project Settings → API keys**, create or copy the server-side
   `service_role` key. Do not put this key in source code or send it in chat.
5. In **Vercel → Smart Skin AI → Settings → Environment Variables**, create:
   - `SUPABASE_URL` = project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = service-role key (Production only)

The existing login system stays in place. This avoids copying legacy password
hashes, and the Vercel backend uses the current account ID to scope all private
records. The legacy SQLite database has no historic scan, feedback, location,
or avatar records to migrate.

## Current scope

The schema and private bucket support scan-history records, user feedback,
nearby environmental context, and profile avatars. The old 6-class TensorFlow
model is deliberately not connected: it is not a validated 50-class release.
