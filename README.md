# Work Tracker

Time-to-money tracker for freelance work, running at `work.denesgarda.com`.

Answers one question: **what does an hour of my time actually end up being worth?**

## How the numbers work

Freelance deposits arrive weeks after the work that earned them, batched into
lumps covering several jobs at once. Rather than guess which hours a given
deposit belongs to, the app sums money and hours over the *same window* and
divides. Over a long enough window the payment lag washes out.

That is why the rate is deliberately **not shown** for week-scale windows: at
that range you would be measuring deposit timing, not the value of your work.
It also stays hidden until a window holds at least 5 hours and one deposit, and
when it is hidden it says why instead of showing a dash. The rolling 90-day
series is the number worth trusting.

Other rules worth knowing:

- **Breaks** pause the clock. Break time is excluded from hours — there is no
  employer paying for it, so counting it would understate your real rate.
- **Hours are attributed to when they happened.** A shift crossing midnight
  splits across both days. (Shift-level views group by start date.)
- **Money is stored in integer cents**, never floats.
- **Jobs never mix.** Each job keeps its own hours and deposits.

## Expenses

A separate, optional ledger of business costs for tax time, on its own tab.
Nothing in it feeds the time-to-money figures.

- **Per job.** Each job is its own business, so every expense belongs to one.
- **Categories are shared** across jobs and managed in Setup. Deleting one
  leaves its expenses in place as Uncategorized.
- **Business-use split.** Leave it off and the whole amount is business use;
  turn it on for a mixed personal/business purchase to record the business
  portion separately.
- **Receipts and statements** attach as photos or PDFs. Large photos are
  shrunk in the browser (about 2000px on the long edge, so small print stays
  legible); small screenshots and PDFs go up untouched.
- **Export for taxes** builds a zip per job and year: a readable summary
  (including any transactions missing a receipt), spreadsheets by transaction,
  category and vendor, and every receipt renamed to match its entry.
  Hand-typed text is neutralised so a vendor name can't run as a formula.

Files live in **R2**, never in D1 (which caps a row at 2 MB). The bucket is
private: files are served only through the Worker, behind Access.

## Architecture

Local-first. The UI reads from an in-memory store hydrated from `localStorage`
and re-renders instantly; the network is asynchronous replication behind it.

```
browser ──HTTP──▶ Worker ──▶ D1 (SQLite)
   ▲                 │
   └───WebSocket─────┴──▶ Durable Object "hub"  (broadcasts "something changed")
```

Every row carries a server-assigned `rev`. Clients pull `?since=<lastRev>`;
deletes are tombstones so they replicate like any other change. A mutation
broadcasts through the Durable Object, and every other open device pulls — which
is why clocking in on your phone updates your laptop without a refresh.

`lastRev` advances **only** from a pull response, never from a mutation's own
response: another device may hold a lower rev you have not seen yet.

The Worker stays deliberately dumb — it reads and writes rows and broadcasts.
All aggregation happens client-side, because the Workers free plan allows 10ms
of CPU per request. I/O wait does not count against that; computing a year of
statistics would.

| File | Role |
|---|---|
| `worker/index.js` | API, Durable Object |
| `worker/access.js` | Cloudflare Access JWT verification |
| `public/js/store.js` | local store, sync, WebSocket, write queue |
| `public/js/stats.js` | all derived metrics — pure, tested |
| `public/js/charts.js` | inline-SVG charts |
| `public/js/app.js` | rendering and interaction |
| `test/stats.test.mjs` | `npm test` |
| `public/js/expenses.js` | expense totals, CSV and export — pure, tested |
| `public/js/zip.js` | minimal zip writer — pure, tested |
| `public/js/files.js` | photo shrinking, upload and delete |
| `public/js/expenses-view.js` | the Expenses tab, editor, categories, export |
| `test/expenses.test.mjs` | `npm test` |

## Everything here fits the free tier

| Component | Free allowance | Expected use |
|---|---|---|
| Static assets | unlimited | — |
| Worker requests | 100k/day | a few hundred |
| Worker CPU | 10ms/request | well under; no server-side aggregation |
| D1 | 5GB, 5M row reads/day | a few thousand rows total |
| Durable Objects | free, **SQLite-backed only** | one object |
| Zero Trust Access | 50 users | 1 |
| R2 | 10 GB, 1M writes and 10M reads a month, free egress | hundreds of receipts ≈ a few hundred MB |

Ping/pong on the socket uses the Durable Object's auto-response, so idle
connections never wake the object and cost nothing against the duration budget.

R2 is the one piece that needs **a payment method on file** to enable, even on
the free tier. Nothing is billed within the limits above, and Access in front
of every route means no one else can generate usage.

## Local development

```sh
npm install
npx wrangler d1 execute work-tracker --local --file=./schema.sql
npm run dev          # http://127.0.0.1:8788
npm test             # stats math
```

Auth is skipped locally while `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are blank.

## Deploying

**Do not merge this to `main` until Cloudflare is serving** — the layout moved
into `public/`, so GitHub Pages will not serve it any more.

1. **Create the database** and paste the returned id into `wrangler.jsonc`:
   ```sh
   npx wrangler d1 create work-tracker
   npm run db:remote
   ```
2. **Deploy:** `npm run deploy`
3. **Point the domain at the Worker.** In the Worker's settings add
   `work.denesgarda.com` as a custom domain. Remove the existing DNS record
   pointing at GitHub Pages first, and turn Pages off for the repo.
4. **Put Access in front of it.** Zero Trust → Access → Applications → Add a
   self-hosted application for `work.denesgarda.com`. Policy: *Emails* →
   your address. Set the session duration to 1 month.
5. **Enforce it in the Worker too**, so hitting the route directly also fails:
   copy the application's **AUD tag** and your team domain
   (`<team>.cloudflareaccess.com`) into `vars` in `wrangler.jsonc`, then
   `npm run deploy` again.
6. Delete `CNAME` — it only mattered to GitHub Pages.

Step 5 is defence in depth. Access already blocks unauthenticated traffic at
the edge; the Worker independently verifies the signed JWT.

### Adding expenses to an existing deployment

The schema is additive, so this leaves existing data untouched.

1. Enable R2 in the Cloudflare dashboard (this is where it asks for a card).
2. `npx wrangler r2 bucket create work-tracker-files` — keep it private; do
   not enable a public r2.dev URL.
3. `npm run db:remote` to create the `categories` and `expenses` tables.
4. `npm run deploy`.

Locally, `wrangler dev` simulates the bucket, so none of this is needed to
preview. It does need `.dev.vars` (gitignored) with blank `ACCESS_TEAM_DOMAIN=`
and `ACCESS_AUD=` lines, or local requests are refused as unauthenticated.
