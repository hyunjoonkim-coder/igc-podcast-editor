# In Good Company · Podcast Editor

A browser-only editor for the *In Good Company* podcast. Pick the host and guest recordings,
mark what to remove, add titles and lower thirds, and render the finished episode as an MP4.
Everything is processed on your own computer, and your videos are never uploaded.

**Open it:** the GitHub Pages link for this repository (Chrome or Edge recommended).

## Team brand files
The intro and outro clips, the music and the logo are **not** in this repository. They are
kept in the team's private Supabase storage. **Sign in** (top right) with your team account to
get them automatically. Ask the editor admin for an account.

- `team.json`: Supabase project URL and *public* anon key (safe to publish; access is
  controlled by row-level security, see `supabase/setup.sql`).
- `supabase/setup.sql`: one-time setup for the private `brand` bucket.

## Run locally
Serve this folder over http (for example `python3 -m http.server 8811`) and open
http://localhost:8811.
