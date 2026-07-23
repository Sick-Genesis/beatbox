// demo-checkout.js
//
// The mock checkout the demo shows in place of a real Gumroad redirect. In
// the live app, Buy opens the producer's own Gumroad and beatbox never
// touches the money — so this pane stands in for "you left for the
// producer's checkout", lets a visitor pick a tier and "pay", and reports the
// purchase back to the store so the beat unlocks and lands in the library.

export function openMockCheckout(beat, store) {
  close();

  const overlay = document.createElement('div');
  overlay.id = 'demo-checkout';
  overlay.className = 'demo-overlay';

  const tiers = beat.licenses || [];
  const tierRows = tiers.map((t, i) => `
    <label class="demo-tier">
      <input type="radio" name="demo-tier" value="${t.kind}" ${i === 0 ? 'checked' : ''}/>
      <span class="demo-tier__kind">${t.kind}</span>
      <span class="demo-tier__price">$${(t.price_cents / 100).toFixed(t.price_cents % 100 ? 2 : 0)}</span>
      <span class="demo-tier__terms">${t.terms || ''}</span>
    </label>`).join('');

  overlay.innerHTML = `
    <div class="demo-modal" role="dialog" aria-modal="true" aria-label="Demo checkout">
      <div class="demo-modal__bar">
        <span>producer checkout · demo</span>
        <button class="demo-modal__x" type="button" aria-label="Close">✕</button>
      </div>
      <div class="demo-modal__body">
        <p class="demo-modal__lead">
          In the real app this opens <b>${escapeHtml(beat.artist)}</b>’s own Gumroad —
          beatbox never handles the money. The beat unlocks here once payment clears.
        </p>
        <h3 class="demo-modal__title">${escapeHtml(beat.title)}</h3>
        <div class="demo-tiers">${tierRows || '<p>No licence tiers.</p>'}</div>
        <button class="demo-buy" type="button">complete demo purchase</button>
        <p class="demo-modal__foot">No card, no charge — this is a portfolio demo.</p>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.demo-modal__x').addEventListener('click', close);
  document.addEventListener('keydown', escClose);

  overlay.querySelector('.demo-buy').addEventListener('click', () => {
    const picked = overlay.querySelector('input[name="demo-tier"]:checked')?.value || 'lease';
    store.completeDemoPurchase(beat, picked);
    close();
    store.demoToast(`Unlocked “${beat.title}” — it’s in your library.`);
    window.beatboxDemo?.reloadBeats?.();
  });
}

function escClose(e) { if (e.key === 'Escape') close(); }

function close() {
  document.getElementById('demo-checkout')?.remove();
  document.removeEventListener('keydown', escClose);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
