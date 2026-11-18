# SCG CRM

Summit Creative Group's sales CRM: leads, contacts, deals, clients, invoices, tasks, shared calendar. Used daily by Chris (owner) and the sales reps. Repo and Render service are named `summit-crm`; the product name is **SCG CRM**.

- Live: https://summit-crm-6fom.onrender.com (Render free plan, sleeps after 15 min idle)
- Database: Neon Postgres
- **This repo is public.** Never commit secrets, real client data or database dumps.

## Stack

Node 18+, Express 4, `pg`, JWT logins (`bcryptjs`), MCP SDK + `zod` for the AI connector, `firebase-admin` for push. Frontend is vanilla JS in a single file. No build step, no framework, no bundler. Keep it that way.

## Run and test

```
npm install
DATABASE_URL=postgres://... JWT_SECRET=dev npm start     # tables are created on boot
npm run seed                                              # once, prints 3 starter logins
node --test test/reporting.test.js test/connect.test.js test/leaderboard.test.js test/trophies.test.js  # no database needed
MCP_TEST_DATABASE_URL=postgres://... node --test test/mcp.test.js   # WIPES that database
```

There is no `npm test` script. Never point `MCP_TEST_DATABASE_URL` at the real Neon database.

## Layout

| Path | What it is |
|---|---|
| `src/server.js` | Express app: login, accounts, `/api/data`, calendar feeds, Google and DocuSign routes, static files |
| `src/db.js` | Pool, table creation, `defaultData()` |
| `src/crmStore.js` | Locked read/modify/write of the CRM document for server-side writers |
| `src/auth.js` | JWT sign/verify, `requireAuth`, `requireAdmin` |
| `src/oauth.js`, `src/mcp.js` | OAuth server and the MCP connector at `/mcp` (Claude and ChatGPT) |
| `src/leadFinder.js` | Endpoints SCG Lead Finder calls (`LEAD_FINDER_KEY`) |
| `src/connect.js` | Endpoints SCG Connect calls, and posts won deals to Connect (`CONNECT_URL`, `CONNECT_KEY`) |
| `src/google.js`, `src/docusign.js`, `src/ics.js` | Gmail send and Google Calendar, DocuSign envelopes, iCal feed parsing |
| `src/push.js` | Android push through Firebase (`FCM_SERVICE_ACCOUNT_JSON`) |
| `src/reporting.js` | Read-only reporting API for SCG Insights |
| `src/trophies.js` | Month-end trophy case: saves each finished month's leaderboard winners and records in `trophies` (hourly check) |
| `src/wonAt.js` | Stamps `deal.wonAt` on every save when a deal enters the won stage |
| `public/leaderboard.js` | Leaderboard math (ranks, windows, streaks, badges, manager trends), shared by the 🏆 tab and its tests |
| `public/index.html` | The whole CRM UI (~1,100 lines) |
| `public/insights/` | SCG Insights, a small analytics sub-app served at `/insights` |
| `public/native.js` | Glue that only runs inside the mobile shell |
| `mobile/` | Capacitor 8 shell for Android and iOS |

## How the data works (read this before changing anything)

- All CRM data is **one JSON document** in `crm_data` (row `id = 1`). Keys: `users`, `cfg`, `leads`, `deals`, `contacts`, `accts`, `acts`, `tasks`, `invoices`, `recur`, `log`, `audit`, `deliv`, `props`, `files`, `templates`, `trophies`.
- The browser loads the whole document with `GET /api/data`, edits it in memory, and saves the whole thing with `PUT /api/data`. Tabs re-pull about every 10 seconds.
- Logins are separate, in the `accounts` table. `accounts.user_id` points at an entry in `users[]`.
- Any server-side write must lock the row (`SELECT ... FOR UPDATE`). Use `crmStore.mutate()` or `mutateData()` in `server.js`. A plain `UPDATE` will lose someone's save.
- Because browsers save whole sections from a possibly stale copy, `keepRecentAiEdits` and `keepRecentTransfers` protect connector and Lead Finder writes for 15 minutes. Records written by the connector carry `aiAt` (and `aiNew`). Keep those guards working if you touch the save path.
- Stage convention used everywhere: the **second-to-last** entry of `cfg.stages` is "won", the **last** is "lost". Don't match on the literal names, teams can rename them.
- Default data lives in two places, `defaultData()` in `src/db.js` and `DEF()` in `public/index.html`. Change both.
- `deal.wonAt` is when a deal entered the won stage, set by the page, the connector and `stampWonAt` on save. Deals won before it existed have none; the leaderboard falls back to the client record's `created` date.
- `trophies` is server-owned: `keepTrophies` puts the database copy back on every browser save, so only `src/trophies.js` writes it. The server runs in `America/Boise` time (set at the top of `server.js`) so month boundaries match the office.
- Schema changes are additive and run on boot (`ADD COLUMN IF NOT EXISTS`, or a small idempotent migration like `ensureNotInterestedDisp`).

## Connector rules (`src/mcp.js`)

View, search, create and edit leads, contacts and deals, plus add notes. No deletes, nothing in invoices, settings or logins. Same business rules as the app: staff can't reassign leads, Closed Lost needs a reason, Closed Won creates the client. Keep the connector and the UI consistent when either changes.

## SCG Insights

Lives inside this app at `/insights`, signs in through `/api/reporting` with an admin CRM login (1-hour session). Whether it becomes a standalone app is undecided, so don't split it out unless asked. Its reports show current ownership and status, not activity in a period, because older records have no reliable close/complete timestamps.

## Mobile

`mobile/` is a Capacitor shell that loads the live site, so web changes reach the apps as soon as Render deploys. Native rebuilds are only for icon, permission or plugin changes.

- A push to `main` touching `mobile/**` runs `.github/workflows/android.yml`, which builds a signed APK and **commits it back to `main`** in `public/downloads/` with `version.json` ("Android build 1.0.N"). Don't edit those files by hand, and pull before pushing.
- iOS (`ios.yml`) only does a Simulator build until the Apple Developer secrets exist. See `mobile/README.md`.
- Push setup is in `mobile/PUSH_SETUP.md`.

## Deploy

Render redeploys automatically on every push to `main`, so **a push to `main` is a production release**. `render.yaml` doesn't list every variable. These are set in the Render dashboard: `LEAD_FINDER_KEY`, `CONNECT_URL`, `CONNECT_KEY`, `FCM_SERVICE_ACCOUNT_JSON`, `PUBLIC_URL`, `MCP_REDIRECT_HOSTS`. New env vars need to be added there, tell Chris which ones.

## Conventions

- Match the existing style. `public/index.html` is dense, short-named vanilla JS; edit it in place rather than restructuring it.
- Pragmatic and simple: no wrapper classes, no new dependencies or build tooling without asking. Comments only where the logic isn't obvious (the existing "why" comments are the model).
- Colors come from the shared SCG palette, already defined as CSS variables at the top of `index.html`: background `#000b19`, panel `#001630`, card `#0a2649`, input `#000f22`, border `#1c3e68`, text `#e8ebf0`, blue `#0b74b8`, cyan accent `#00e0f5`.
- The README predates the Google and DocuSign integrations and is out of date in places. Trust the code.
- Explain changes to Chris in plain language, and write any setup steps click by click like the README does.

## Sister apps

SCG Lead Finder (`scg-lead-finder`), SCG Connect (`summit-connect`), SCG Business Audit (`summit-audit`), SCG Client Portal (`scg-client-portal`). Lead Finder and Connect call this app's `/api/integrations/*` endpoints with shared keys, so changing those request or response shapes means changing the other repo too.
