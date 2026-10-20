# Summit CRM — standalone web app

This replaces the claude.ai-hosted version of the CRM. No claude.ai account is
needed anymore — your team signs in with their own username and password, and
the data lives in a database you control instead of on claude.ai.

Traded away to get here: the Gmail / Calendar / Drive / Slack buttons (those
only existed because claude.ai provided them) and the previous "shared ●"
syncing — this version syncs every ~10 seconds instead of instantly.

## What's here

- `src/server.js` — the API + the thing that serves the app itself
- `public/index.html` — the CRM, same UI/features as before, now talking to
  this server instead of claude.ai
- `src/seed.js` — run once, after first deploy, to create the 3 starting logins

## Deploying (free, no servers to manage)

You'll need two free accounts: **Neon** (a Postgres database) and **Render**
(runs the app). Both are plain web sign-ups — no credit card for the tiers
used here.

### 1. Database — Neon

1. Go to neon.tech and sign up / sign in.
2. Create a new project (any name, e.g. "summit-crm").
3. On the project dashboard, copy the **connection string** (it starts with
   `postgresql://...`). You'll paste this into Render in step 3.

### 2. Deploy — Render

1. Go to render.com and sign up / sign in with GitHub.
2. New → Blueprint → pick this repo. Render reads `render.yaml` in this
   folder and sets most things up automatically.
3. When it asks for the `DATABASE_URL` environment variable, paste the Neon
   connection string from step 1.
4. Deploy. First deploy takes a couple of minutes. You'll get a URL like
   `https://summit-crm-xxxx.onrender.com`.

   (Free Render web services sleep after 15 minutes of no traffic and take
   ~30-60 seconds to wake back up on the next visit. If that's annoying,
   Render's cheapest paid tier, around $7/month, keeps it always on.)

### 3. Create the first logins

Once it's deployed, create the 3 starting team logins by running the seed
script once. In the Render dashboard, open your service → **Shell** tab, and
run:

```
npm run seed
```

It prints a username and temporary password for Alex (admin), Sarah, and
Jordan. **Copy these down — they're only shown this one time.** Share each
person's login with them; they can change their password from Settings once
signed in. Alex is set as admin and can create logins for anyone else added
later (Settings → Team → "+ Login").

### 4. Sign in

Visit your Render URL, sign in with one of the seeded logins, and you're in.

## Updating later

Edit files directly on GitHub (or push from a local clone) — Render redeploys
automatically from the `main` branch.
