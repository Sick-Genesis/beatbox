# beatbox — architecture & mechanisms

How the project actually works today. Kept up to date as things change.

**Status:** front-end prototype + backend foundation. The data model is in
place; nothing sells yet.

Last updated: 2026-07-21

---

## Contents

- [The shape of the thing](#the-shape-of-the-thing)
- [Front-end: the SVG layout](#front-end-the-svg-layout)
- [The global-script layer](#the-global-script-layer)
- [Data layer](#data-layer)
- [Database schema](#database-schema)
- [Selling mechanism](#selling-mechanism)
- [Trade mechanism](#trade-mechanism)
- [Build & run](#build--run)
- [What's not built yet](#whats-not-built-yet)
- [Known issues](#known-issues)

---

## The shape of the thing

beatbox is a beat marketplace with an unusual front end: the entire chrome
is one hand-authored SVG drawn in a `0 0 100 100` coordinate space, styled
to look like a cassette deck. The interface is the differentiator — see
[market-ux-research.html](market-ux-research.html) for why that matters
commercially.

Two layers, deliberately kept apart:

| Layer | Files | Module system |
|---|---|---|
| **App / UI** | `*.js` at repo root | Classic scripts, shared globals |
| **Data** | `src/*.js` | ES modules, bundled by Vite |

The root scripts predate the backend and rely on load order and globals.
Rather than rewrite them, the data layer reaches *into* them. That
boundary is the single most important thing to understand here, and it's
the source of the in-place-mutation rule below.

---

## Front-end: the SVG layout

`index.html` contains one `<svg class="layout" viewBox="0 0 100 100"
preserveAspectRatio="none">`. Everything visible — the top bar, sidebar,
panels, transport buttons — is drawn in that 100×100 space.

`preserveAspectRatio="none"` means the SVG stretches non-uniformly to fill
the viewport. Good for panels; it would turn circular buttons into
ellipses.

**`aspect-fix.js`** solves that. Elements marked `.keep-aspect` carry
`data-cx` / `data-cy` (their center in viewBox units) and get an inverse
counter-scale around that point, so circles stay circular at any window
ratio. Recomputed on resize.

**`theme-toggle.js`** sets `data-theme="dark"` on `<html>`, persisted to
`localStorage` under `beatbox-theme`, and swaps the sun/moon icon groups.
Dark mode is CSS-only from there: `style.css` recolors SVG elements by
attribute selector (`[stroke="black"]` → acid green `#c8ff00`), targeting
only elements that already declared a stroke so weights don't drift.

---

## The global-script layer

Load order in `index.html` is significant and enforced by tag order:

```
aspect-fix.js     → SVG geometry correction
theme-toggle.js   → light/dark
beat-data.js      → defines window.beatBank (placeholder rows)
carousel.js       → reads beatBank, exposes window.beatCarousel
view-toggle.js    → list ⇄ carousel visibility
upload-toggle.js  → upload overlay visibility
upload.js         → upload form, pushes into beatBank
transport.js      → audio playback, reads beatBank + beatCarousel
src/main.js       → (module, deferred) swaps in real data
```

`src/main.js` is `type="module"`, so it's deferred automatically and runs
**after** every classic script above. That ordering is what lets it
replace the placeholder data once the real rows arrive.

### Shared globals

| Global | Defined in | Used by |
|---|---|---|
| `window.beatBank` | `beat-data.js` | `carousel.js`, `transport.js`, `upload.js`, `src/main.js` |
| `window.beatCarousel` | `carousel.js` | `transport.js`, `src/main.js` |
| `window.uploadToggle` | `upload-toggle.js` | `upload.js` |

### ⚠ The in-place mutation rule

`carousel.js` captures the array **by reference** at IIFE time:

```js
const items = beatBank;   // carousel.js
```

So reassigning `window.beatBank = [...]` would leave the carousel
rendering a detached copy forever, with no error. All data updates must
mutate the existing array:

```js
targetArray.splice(0, targetArray.length, ...entries);   // beats-repo.js
```

This is why `syncInto()` exists and why `beat-data.js` declares
`window.beatBank = [...]` rather than `const beatBank`.

### Transport

`transport.js` wires the SVG controls to a single `Audio` element. Two
things worth knowing:

**Hit detection is coordinate math, not DOM listeners.** The arrow
graphics are siblings of the button circles rather than children, so
clicks on an arrow would miss a listener bound to the circle. Instead a
single click handler on the SVG converts the click to viewBox coordinates
and measures distance to each button center. Works — but see
[Known issues](#known-issues).

**Audio source priority:**
1. `track.audioBlob` — picked this session, not yet uploaded
2. `track.audioUrl` — absolute URL from Supabase storage
3. `banks/<bank>/<file>` — original local layout, placeholder data

Volume is read from the `#slider-knob` `cx` attribute via a
`MutationObserver` — the knob drag handler in `index.html` only moves the
circle, and transport observes it rather than the two being coupled.

---

## Data layer

Three modules under `src/`.

### `supabase-client.js`

One shared client. Exports `supabase` and `isConfigured`. If env vars are
missing, `supabase` is `null` and a console warning explains the fix —
the app then runs on placeholder data rather than crashing.

Both env values are public by design: the anon key grants only what row-
level security allows. Real secrets never appear in browser code.

### `beats-repo.js`

Fetch, map, and create beats.

- `fetchBeats()` — published beats with their license tiers, newest first
- `syncInto(target, entries)` — in-place array replacement (see rule above)
- `createBeat({...})` — upload audio + artwork, insert row, insert tiers
- `currentUser()`

`toBeatBankEntry()` maps a DB row to the exact shape the existing scripts
expect. Keeping that shape stable is what lets `carousel.js` and
`transport.js` work unchanged against real data.

Storage **paths** are stored, not URLs, and resolved at read time. That
means buckets can become private later (signed URLs after purchase)
without migrating a single row.

`createBeat()` cleans up after itself: if the DB insert fails after files
have uploaded, it removes the orphaned objects from storage.

### `trades-repo.js`

Barter negotiation. `proposeTrade`, `counterTrade`, `acceptTrade`,
`declineTrade`, `withdrawTrade`, `listOffers`, `listTrades`,
`pendingOfferCount`.

Settlement deliberately does **not** happen here — `acceptTrade()` calls
a Postgres function. See [Trade mechanism](#trade-mechanism).

> Not yet imported by `main.js`. No UI calls it.

### `reports-repo.js`

Takedown and dispute filing: `fileReport`, `listReports`,
`withdrawReport`, plus `REPORT_KINDS`. Works signed-out, by design.

> Not yet imported by `main.js`. No UI calls it.

---

## Database schema

Supabase (hosted Postgres). Files:

- `supabase/schema.sql` — base tables, RLS, storage buckets
- `supabase/migrations/002_trades.sql` — trade mechanism (exclusive swaps)
- `supabase/migrations/003_lease_trades.sql` — `licenses` table; lease and
  mixed-kind trades; rewrites `accept_trade_offer()`
- `supabase/migrations/004_rights_and_disputes.sql` — rights warranty at
  upload, `reports` table, beat withdrawal, declared trade values;
  rewrites `accept_trade_offer()` again
- `supabase/migrations/005_roles.sql` — buyer/producer roles, upload gated
  on role, self-promotion blocked
- `supabase/migrations/006_producer_as_capability.sql` — drops the signup
  role choice; producer is earned via `become_producer()` on first upload

Run in order via the Supabase SQL editor. Both are idempotent.

### Tables

**`profiles`** — one row per user, mirrors `auth.users`. Created
automatically by the `handle_new_user()` trigger on signup.

**`beats`** — one row per beat.

| Column | Note |
|---|---|
| `producer_id` | **Creator credit. Never changes**, including after a trade |
| `rights_holder_id` | Who currently controls the beat; moves on trade |
| `audio_path` / `artwork_path` | Storage paths, not URLs |
| `bpm`, `musical_key`, `tags[]` | The fields buyers filter on |
| `status` | `draft` / `published` / `sold_exclusive` / `traded` |

**`license_tiers`** — the **price list**: what a beat is offered at.
`unique (beat_id, kind)` so one beat can't have two contradictory lease
prices.

**`licenses`** — the **ledger of granted rights**: what has actually been
handed over, by purchase or by trade. Terms are *snapshotted* at grant
time rather than referenced, so later price or wording changes never
retroactively alter a license someone already holds.

> `license_tiers` vs `licenses` is easy to mix up. Tiers are the menu;
> licenses are the receipts.

**`trade_offers`** — barter negotiation (see below).

**`trades`** — immutable ledger of settled swaps.

### Row-level security

On for every table. Broadly: **read is public** (it's a shop), **writes
are owner-only**. Drafts are visible only to their owner.

After `002_trades.sql`, beat write policies key on `rights_holder_id`
rather than `producer_id` — the current holder controls listing and
pricing, not the original creator.

Storage uploads are namespaced `<user-id>/<file>` and the policy enforces
that prefix, so producers can't overwrite each other's files.

---

## Selling mechanism

**Schema only. Nothing executes a sale yet.**

A beat is never sold as a file — it's sold as a **license**, and one beat
carries several tiers at once:

| Tier | Typical | Exclusive? |
|---|---|---|
| `lease` | $20–50, MP3/WAV | No — sell to unlimited buyers |
| `premium` | mid, stems included | No |
| `exclusive` | $200–500+ | **Yes** — withdraws the beat from sale |

### Why `status` is an enum, not a `sold` boolean

Because **the same beat is sold many times and stays for sale**. A lease
is non-exclusive: 50 sales at $50 each, and it's still listed and still
earning. A `sold = true` flag after the first lease would destroy the
business model.

"Sold" isn't a property of the beat — it's a property of a *transaction*.
The only sale that changes the beat's own state is the exclusive, because
that's the one where the producer is contractually barred from selling
again. `sold_exclusive` means *"can no longer be purchased,"* not
*"has been purchased."*

---

## Trade mechanism

Direct barter: two producers swap rights to one beat each, no money
involved. Not offered by BeatStars, Airbit, or Traktrain.

### Leases trade differently from exclusives

Each side of an offer names **what kind of license it grants** —
`offered_kind` and `wanted_kind`. Mixed trades are allowed (my exclusive
for your lease); fairness is settled in the negotiation, not the schema.

The distinction that drives everything:

| Grant | Ownership | Beat status | Still on sale? |
|---|---|---|---|
| `exclusive` | `rights_holder_id` moves | → `traded` | **No** |
| `lease` / `premium` | unchanged | unchanged | **Yes** |

A lease trade is **not a swap of beat rows at all**. Nobody's ownership
changes. It's the *mutual issuance of two licenses* — each producer keeps
their beat, keeps selling it, and has simply granted one more
non-exclusive license. That's why the `licenses` table had to exist before
lease trading could work, and why `accept_trade_offer()` evaluates each
side independently.

One consequence worth remembering: **only an exclusive grant cancels other
pending offers.** A lease trade leaves every other open negotiation valid,
because the beat never left the market.

### Creator vs rights holder

The split that makes trading possible. `producer_id` is permanent credit;
`rights_holder_id` is control and crosses over in a trade. So you can
trade a beat away, the credit stays honest, and the new holder can
re-trade it.

`traded` is kept distinct from `sold_exclusive` — both mean rights moved,
but *how* is worth preserving.

### Negotiation

Barter has no common unit, so fairness can't be settled by price — only by
conversation. Hence `trade_offers`: propose → counter → accept/decline.

Counter-offers **chain rather than mutate**. A counter inserts a new offer
linked by `counter_of_id` and marks the original `countered`, so the whole
back-and-forth stays readable as history.

### Atomic settlement — `accept_trade_offer()`

The critical piece. All in one Postgres transaction:

1. Lock the offer row
2. Lock **both beats in sorted-id order** — prevents the deadlock where
   two simultaneous trades grab the same pair in opposite orders
3. **Re-verify ownership after locking** — between an offer being made and
   accepted, either beat may have been traded away by someone else
4. For each side independently: issue a `licenses` row, and *only if the
   grant is exclusive*, move `rights_holder_id` and mark the beat `traded`
5. Cancel other pending offers — **only** for beats whose exclusive moved
6. Append to the `trades` ledger

Doing 3–5 client-side would leave a window where two people accept offers
on the same beat and someone hands over a beat for nothing. That race is
the entire reason this lives in the database.

A partial unique index (`licenses_one_exclusive_per_beat`) guarantees at
most one exclusive license per beat at the database level, whatever
application code does.

The `trades` table has a `select` policy and **no** insert/update/delete
policy, making it append-only — only this `security definer` function
writes to it.

---

## Auth

Supabase auth, with UI modelled on the flow from the `live-love-vomit`
project: an inline auth bar, a modal signup with a role selector, a `?`
for password reset, and toasts for feedback.

**The plumbing underneath is deliberately different.** That project uses
Express + bcrypt + self-signed JWTs in `localStorage`, with users in a
JSON file. beatbox has no server: every RLS policy across all five
migrations is written against `auth.uid()` from a Supabase token. Porting
the mechanism would mean rewriting all of them as application middleware,
including the atomic trade settlement. Only the interaction design carried
over.

Two things that came free with Supabase: refresh-token rotation with short
expiry (rather than a static 7-day token), and password reset over real
email (rather than a link logged to the server console).

### Files

| File | Role |
|---|---|
| `src/auth.js` | Session, sign-up/in/out, reset, profile updates |
| `src/auth-ui.js` | Auth bar, modals, toasts |
| `auth.css` | Styling — reuses `style.css` tokens, so dark mode is inherited |

`initAuthUI()` is called from `main.js` and **bails when Supabase is
unconfigured**, so the bar never appears with nothing behind it.

### Roles — producer is a capability, not an identity

**Everyone can buy, license and trade from the moment they sign up.**
`profiles.role` gates exactly one thing: uploading. Nothing else in the
schema has ever checked it.

That matters because producers buy constantly — producers licensing and
trading each other's beats is much of the activity in this market. An
earlier version presented buyer/producer as a choice at signup, which
implied producers don't buy and created dead-end accounts: pick `buyer`,
later want to upload, and there was no way out.

The flow now:

1. Sign up — no role question. You get `buyer`, and can license and trade.
2. First upload — accepting the rights warranty calls `become_producer()`,
   which promotes the account and records `producer_since` plus the
   warranty wording.
3. Upload proceeds.

Three things keep the role honest:

- `handle_new_user()` **always** writes `buyer`. It no longer reads a role
  from signup metadata, so a crafted request cannot skip the warranty.
- `prevent_role_self_change()` blocks every client-side role change except
  the one sanctioned transition: `buyer → producer` with the warranty
  columns set alongside it. Demotion and everything else still raises.
- The beat insert policy requires `is_producer()`.

> The role is read from the profiles row, **not** from a token claim.
> That's the main departure from `live-love-vomit`, and it means a role
> change takes effect on the next read rather than when a token expires.

Since anyone can become a producer by accepting the warranty, strangers
can upload from day one — which makes the rights warranty and takedown
machinery in `004` load-bearing rather than precautionary.

---

## Rights, takedowns & disputes

> **Not legal advice, and not compliance.** These are the data structures
> that make compliance *possible*. Terms of service, a designated takedown
> agent, and jurisdiction-specific advice are separate work — and for a
> multi-producer platform, that means a lawyer who knows music licensing.

### Rights warranty at upload

`createBeat()` refuses to upload without `rightsWarranted: true`, and
records three things on the beat:

- `rights_warranted_at` — when they affirmed
- `rights_warranty_text` — **the verbatim wording they were shown**
- `contains_samples` / `sample_notes` — declared third-party material

The wording is snapshotted rather than referenced because proving what
someone agreed to requires the text they saw, not a boolean. Editing
`RIGHTS_WARRANTY_TEXT` in `beats-repo.js` creates a new warranty going
forward; earlier beats keep theirs.

Uncleared samples are the most common source of infringement claims in
this market, which is why the declaration is explicit rather than inferred
from silence.

### Withdrawal is a separate axis from status

`withdrawn_at` is **not** part of the `status` enum, deliberately. A beat
can be pulled under a rights claim whether it's draft, published, traded,
or sold — the two axes are independent, and overloading `status` would
lose information about which state it was in when pulled.

Withdrawn beats vanish from the shop for everyone except their producer
and rights holder, and cannot be traded.

### Reports

`reports` covers copyright claims, uncleared samples, impersonation, and
contested trades.

**Filing does not require an account.** A rights holder who has never used
beatbox must still be able to complain — a takedown process only usable by
registered users isn't usable by the people most likely to need it. Hence
`reporter_email` for anonymous filers, and an insert policy of `true`.

There is **no update policy** on `reports`. Resolving one is a moderation
action needing elevated privileges, deliberately outside client code.
`withdrawReport()` exists for the UI but won't succeed until a moderation
path is built.

### Declared values on trades

Barter is taxable in most jurisdictions: each party owes tax on the fair
market value of what they received, even though no money moved. People
routinely don't expect this.

`offered_declared_value_cents` / `wanted_declared_value_cents` record what
**the parties** say each side is worth, carried through to the `trades`
ledger. beatbox records the declaration; it does not value anything. Keep
that distinction in any UI wording.

### Settlement gates

`accept_trade_offer()` refuses a trade when either beat is withdrawn or
has no rights declaration. Both are re-checked at settlement, not just at
offer time, because a beat can be withdrawn in between.

---

## Build & run

```bash
npm install
cp .env.example .env.local     # fill in from Supabase dashboard
npm run dev                    # localhost:5173
npm run build                  # → dist/
```

Without `.env.local` the app still runs, on placeholder data, with a
console warning.

### The Vite config quirk

The root scripts are **not** modules and can't be bundled — they rely on
shared globals and load order. Vite leaves their tags pointing at the
original filenames and warns about it.

Left alone, those files never reach `dist/` and the built site 404s on all
eight. `vite.config.js` has a small `copy-classic-scripts` plugin that
copies them verbatim after the bundle is written.

**If you add a classic script at the repo root, add it to
`CLASSIC_SCRIPTS` in `vite.config.js`** or it won't survive a production
build. Dev server is unaffected.

`publicDir` is `asset/`, so `asset/sound/scroll.wav` is served from
`/sound/scroll.wav`.

---

## What's not built yet

Ordered roughly by what blocks what.

- **Upload is still local.** `upload.js` pushes a blob into `beatBank`;
  it does not call `createBeat()`. Uploads vanish on refresh, and the
  form has no rights-warranty checkbox yet — `createBeat()` will reject
  until it does.
- **No profile or account screen.** `updateProfile()` exists; nothing
  calls it.
- **No password-reset page.** `requestPasswordReset()` sends a link to
  `/reset-password`, which does not exist yet.
- **No orders table, no payment.** Nothing records a *purchase*. The
  `licenses` table is ready for it (`origin = 'purchase'`, `order_id`),
  but only trades write there today. Nothing flips `sold_exclusive` — a
  producer would have to change it by hand.
- **No trade UI.** `trades-repo.js` is unreferenced.
- **No moderation path.** `reports` can be filed but not resolved —
  nothing can withdraw a beat, uphold a claim, or act on repeat
  infringers. The columns exist; the admin surface does not.
- **No terms of service, no takedown agent.** The schema supports a
  takedown process; the legal and operational sides don't exist.
- **No dispute reversal.** `accept_trade_offer()` is irreversible by
  design. There is no way to undo a trade made in error or bad faith,
  short of a manual database fix.
- **No file gating.** Buying delivers nothing; audio sits in one public
  bucket.
- **No watermarking.** Previews stream the full clean file, so the preview
  *is* the product. Load-bearing for revenue existing at all.
- **No waveform player**, no search/filter, no tag UI.
- **Bookmark star is decorative** — `index.html` has starred rows, nothing
  persists them.
- **List view is hardcoded HTML.** The `<tbody>` rows are static markup,
  unconnected to `beatBank`. Only the carousel renders real data.

---

## Known issues

**Fixed `viewBox` won't survive mobile.** Coordinates are absolute in a
100×100 space. A large share of beat browsing is on phones. Easier to
design for now than to retrofit.

**Transport is invisible to keyboards and screen readers.** Hit detection
is coordinate math against click position, not focusable DOM elements, so
play/prev/next can't be tabbed to or announced. Fine in an art piece; a
real accessibility and legal problem once money changes hands.

**Leases survive an exclusive trade.** If a beat is leased 40 times and
then traded away exclusively, the new rights holder inherits those live
licenses — the `licenses` rows persist and stay valid. Legally correct,
but it must be surfaced in the trade UI ("this beat has 40 active
leases") or it's a nasty surprise for the person receiving it.

**`beat-data.js` placeholders are load-bearing.** They're the fallback when
Supabase is unconfigured or empty. Deleting them gives a blank carousel.

**Marketplace ≠ shop, legally.** Selling your own catalog is a shop. Other
people uploading and trading makes you an intermediary, with obligations
that follow — takedown handling, repeat-infringer policy, and exposure to
what users upload. The Path A / Path B fork in the research doc is
therefore a legal fork too, not only a product one. Path A carries a
fraction of the exposure, because you know the provenance of everything
in your own catalog.

**Reporter contact details are visible to beat owners.** Normal for a
counter-notice process, but it must be stated in the terms, and it means
anonymous-to-the-public is not anonymous-to-the-accused.
