// demo-chrome.js
//
// Everything that frames the app as a demo:
//   - a fixed DEMO badge
//   - the signed-in bar (@sila), replacing the real sign-in fields
//   - a one-time intro notice explaining what the visitor is looking at
//   - a working "library" panel (purchases are real data)
//   - "in development" panels on the parts with no UI yet (offers, messaging)
//
// It reads from the store and, for the offers panel, shows the seeded pending
// offer so the roadmap reads as real product, not an empty stub.

export function mountDemoChrome(store) {
  mountBadge();
  mountSignedInBar(store);
  mountIntro();
  wireSidebarIcons(store);
}

// ── DEMO badge ───────────────────────────────────────────────────────────────

function mountBadge() {
  const b = document.createElement("a");
  b.className = "demo-badge";
  b.href = "https://github.com/Sick-Genesis/beatbox";
  b.target = "_blank";
  b.rel = "noopener";
  b.innerHTML = '<span class="demo-badge__dot"></span> DEMO · in development';
  b.title =
    "This is an interactive demo running on sample data. Click for the source.";
  document.body.appendChild(b);
}

// ── Signed-in bar ────────────────────────────────────────────────────────────
//
// The real auth-ui would render sign-in fields; in the demo the visitor is
// already @sila, so show that instead. auth-ui.initAuthUI still runs but its
// bar is replaced here.

function mountSignedInBar(store) {
  const render = () => {
    let bar = document.getElementById("auth-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "auth-bar";
      bar.className = "auth-bar";
      document.body.appendChild(bar);
    }
    const s = store.getSessionSync();
    // Library lives here, next to the account — "my stuff" is an account
    // affordance, kept distinct from the sidebar's ★ favourites.
    bar.innerHTML = `
      <span class="auth-bar__who">@${s.handle}</span>
      <button class="auth-btn" id="demo-library" type="button">library</button>
      <button class="auth-btn" id="demo-signout" type="button">sign out</button>`;
    bar
      .querySelector("#demo-library")
      .addEventListener("click", () => openLibrary(store));
    bar
      .querySelector("#demo-signout")
      .addEventListener("click", () => store.signOut());
  };
  // Render now and again shortly after, in case auth-ui repaints its own bar.
  render();
  setTimeout(render, 300);
}

// ── Intro notice ─────────────────────────────────────────────────────────────

function mountIntro() {
  if (sessionStorage.getItem("demo-intro-seen")) return;

  const el = document.createElement("div");
  el.className = "demo-intro";
  el.innerHTML = `
    <button class="demo-intro__x" type="button" aria-label="Dismiss">✕</button>
    <h2>You’re inside beatbox.</h2>
    <p>
      An interactive demo of a beat marketplace we are building, on fake ai-generated data.
      You’re signed in as <b>@sila</b>, a producer. Play beats, open a row for
      licences, buy one, or upload your own. Nothing is saved;
      a refresh resets everything.
    </p>
    <button class="demo-intro__go" type="button">start exploring</button>`;
  document.body.appendChild(el);

  const dismiss = () => {
    sessionStorage.setItem("demo-intro-seen", "1");
    el.remove();
  };
  el.querySelector(".demo-intro__x").addEventListener("click", dismiss);
  el.querySelector(".demo-intro__go").addEventListener("click", dismiss);
}

// ── Sidebar icons: library (real) + offers/messaging (roadmap) ───────────────
//
// The SVG sidebar has a bookmarks star and an envelope. We overlay clickable
// hit-areas positioned over them (the SVG uses a 0..100 viewBox scaled to the
// viewport), and open panels: the star → the visitor's library (real
// purchases), the envelope → the offers inbox (seeded offer + "in development"
// framing).

function wireSidebarIcons(store) {
  const svg = document.querySelector("svg.layout");
  if (!svg) return;

  // Overlay buttons, positioned as a % of the SVG box to track its scaling.
  // ★ is favourites (bookmarked beats), distinct from the library in the
  // account bar; the envelope is trade offers.
  addHit(svg, { cx: 2.5, cy: 27.8, label: "Favourites" }, () =>
    openFavourites(),
  );
  addHit(svg, { cx: 2.5, cy: 34.4, label: "Trade offers" }, () =>
    openOffers(store),
  );

  // Show the pending-offer count as a small badge over the envelope.
  store.pendingOfferCount().then((n) => {
    if (n > 0) addBadge(svg, { cx: 4.4, cy: 33.2 }, n);
  });
}

function pctPoint(svg, cx, cy) {
  // Map an SVG-units point (0..100 box, non-uniform scale) to page px.
  const r = svg.getBoundingClientRect();
  return { x: r.left + (cx / 100) * r.width, y: r.top + (cy / 100) * r.height };
}

function addHit(svg, { cx, cy, label }, onClick) {
  const btn = document.createElement("button");
  btn.className = "demo-hit";
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  const place = () => {
    const p = pctPoint(svg, cx, cy);
    btn.style.left = `${p.x}px`;
    btn.style.top = `${p.y}px`;
  };
  document.body.appendChild(btn);
  place();
  window.addEventListener("resize", place);
  btn.addEventListener("click", onClick);
}

function addBadge(svg, { cx, cy }, n) {
  const el = document.createElement("span");
  el.className = "demo-count";
  el.textContent = String(n);
  const place = () => {
    const p = pctPoint(svg, cx, cy);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  };
  document.body.appendChild(el);
  place();
  window.addEventListener("resize", place);
}

// ── Panels ───────────────────────────────────────────────────────────────────

function panel(title, bodyHtml, { roadmap = false } = {}) {
  document.getElementById("demo-panel")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "demo-panel";
  overlay.className = "demo-overlay";
  overlay.innerHTML = `
    <div class="demo-modal" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="demo-modal__bar">
        <span>${title}${roadmap ? " · in development" : ""}</span>
        <button class="demo-modal__x" type="button" aria-label="Close">✕</button>
      </div>
      <div class="demo-modal__body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".demo-modal__x").addEventListener("click", close);
  return overlay;
}

async function openLibrary(store) {
  const purchases = await store.listPurchases();
  const rows = purchases.length
    ? purchases
        .map(
          (p) => `
        <li class="demo-lib__row">
          <span class="demo-lib__title">${esc(p.beat.title)}</span>
          <span class="demo-lib__artist">${esc(p.beat.artist)}</span>
          <span class="demo-lib__kind">${p.kind}</span>
          <span class="demo-lib__price">$${(p.price_cents / 100).toFixed(0)}</span>
          <button class="demo-lib__dl" data-beat="${p.beat.id}">download</button>
        </li>`,
        )
        .join("")
    : '<li class="demo-lib__empty">Nothing yet — buy or claim a beat and it lands here.</li>';

  const overlay = panel(
    "Your library",
    `
    <p class="demo-modal__lead">Everything you own, however you got it. This list is live demo data.</p>
    <ul class="demo-lib">${rows}</ul>`,
  );

  overlay.querySelectorAll(".demo-lib__dl").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await store.getMasterDownloadUrl(btn.dataset.beat);
    });
  });
}

function openFavourites() {
  // Favourites are the beats starred with the row ★ in the list view. That
  // toggles `.bookmark.starred` on a row; read those back to window.beatBank.
  const starred = [];
  document.querySelectorAll("tr.track-row").forEach((row) => {
    if (row.querySelector(".bookmark.starred")) {
      const i = Number(row.dataset.index);
      const beat = window.beatBank?.[i];
      if (beat) starred.push(beat);
    }
  });

  const rows = starred.length
    ? starred
        .map(
          (b) => `
        <li class="demo-lib__row">
          <span class="demo-lib__title">${esc(b.title)}</span>
          <span class="demo-lib__artist">${esc(b.artist)}</span>
          <span class="demo-lib__kind">${b.isFree ? "free" : b.bpm ? b.bpm + " bpm" : ""}</span>
          <span class="demo-lib__price"></span>
        </li>`,
        )
        .join("")
    : '<li class="demo-lib__empty">No favourites yet — tap the ☆ on any beat to save it here.</li>';

  panel(
    "Favourites",
    `
    <p class="demo-modal__lead">Beats you’ve starred. Just a shortlist — saving one doesn’t buy it.</p>
    <ul class="demo-lib">${rows}</ul>`,
  );
}

async function openOffers(store) {
  const offers = await store.listOffers({ box: "incoming", status: "pending" });
  const cards = offers
    .map(
      (o) => `
    <div class="demo-offer">
      <div class="demo-offer__swap">
        <div class="demo-offer__side">
          <span class="demo-offer__label">they give</span>
          <b>${esc(o.offered_beat.title)}</b>
          <span>${esc(o.offered_beat.artist)} · ${o.offered_kind}</span>
        </div>
        <span class="demo-offer__arrow">⇄</span>
        <div class="demo-offer__side">
          <span class="demo-offer__label">for your</span>
          <b>${esc(o.wanted_beat.title)}</b>
          <span>${esc(o.wanted_beat.artist)} · ${o.wanted_kind}</span>
        </div>
      </div>
      <p class="demo-offer__msg">“${esc(o.message)}”</p>
      <div class="demo-offer__actions">
        <button class="demo-offer__accept" data-id="${o.id}">accept</button>
        <button class="demo-offer__decline" data-id="${o.id}">decline</button>
      </div>
    </div>`,
    )
    .join("");

  const overlay = panel(
    "Trade offers",
    `
    <p class="demo-modal__lead">
      Producers barter exclusive rights beat-for-beat — no money. The negotiation
      (offer, counter, accept) is the feature. This inbox is a preview of that
      interface; the settlement logic underneath is already built.
    </p>
    ${cards || "<p>No open offers.</p>"}`,
    { roadmap: true },
  );

  overlay.querySelectorAll(".demo-offer__accept").forEach((b) =>
    b.addEventListener("click", async () => {
      await store.acceptTrade(b.dataset.id);
      overlay.remove();
    }),
  );
  overlay.querySelectorAll(".demo-offer__decline").forEach((b) =>
    b.addEventListener("click", async () => {
      await store.declineTrade(b.dataset.id);
      overlay.remove();
    }),
  );
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
