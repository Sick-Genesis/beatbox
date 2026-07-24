# beatbox

A beat marketplace with a hand-drawn SVG interface.

## Quick start

```bash
npm install
cp .env.example .env.local     # fill in from your Supabase dashboard
npm run dev
```

The app runs without Supabase configured — it falls back to placeholder
data and logs a warning.

## Docs

- **[Architecture & mechanisms](docs/ARCHITECTURE.md)** — how everything
  works: the SVG layout, the global-script layer, the data layer, the
  selling and trade models. Start here.
- **[Market & UX research](docs/market-ux-research.html)** — competitor
  analysis and the build roadmap. Open in a browser.

## Database

Run against your Supabase project's SQL editor, in order:

1. `supabase/schema.sql`
2. Every file in `supabase/migrations/`, in filename order
   (`002_trades.sql`, `003_lease_trades.sql`, … up to the highest number).

All are idempotent — safe to re-run, and safe to run again after pulling
new migrations.
