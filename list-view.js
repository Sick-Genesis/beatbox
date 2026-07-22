// list-view.js
//
// Renders beatBank into the .tracklist table, the counterpart to
// carousel.js. Was previously static markup; main.js calls
// window.beatList.rebuild() after data loads, the same way it drives the
// carousel.
//
// Each row, always visible:
//   ▶ play · Title · Artist · Price/Free · Time · ⓘ info · ★ bookmark
//
// Interactions:
//   ▶ or double-click row → play the preview (via window.beatCarousel.goTo
//     + the transport, so the list and carousel share one selection)
//   ⓘ → expand the row to reveal BPM · Key · tags · license tiers
//   ★ → toggle bookmark (local only for now)

(function () {
  const tbody = document.querySelector('.tracklist tbody');
  if (!tbody || typeof beatBank === 'undefined') return;

  // Durations are read lazily from the audio and cached, since the beat
  // rows do not carry a stored length yet.
  const durationCache = new Map();

  function fmtTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '—';
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }

  // Lowest license price, or "Free", or "—" when nothing is priced yet.
  function priceLabel(item) {
    if (item.isFree) return 'Free';
    const tiers = item.licenses || [];
    if (!tiers.length) return '—';
    const cents = Math.min(...tiers.map((t) => t.price_cents));
    return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
  }

  function play(index) {
    // Route through the carousel so both views track one current item, and
    // transport.js (which reads beatCarousel.currentIndex) plays the right
    // beat. Then nudge playback via the transport play button hit-area.
    if (window.beatCarousel) window.beatCarousel.goTo(index);
    // transport.js listens on the SVG; dispatch a click at the play circle.
    window.beatTransport?.play?.();
    markPlaying(index);
  }

  function markPlaying(index) {
    tbody.querySelectorAll('tr.track-row').forEach((tr) => {
      tr.classList.toggle('is-playing', Number(tr.dataset.index) === index);
    });
  }

  function toggleInfo(row, item) {
    const existing = row.nextElementSibling;
    const isOpen = existing && existing.classList.contains('detail-row');

    // Close any other open detail first — one at a time keeps it tidy.
    tbody.querySelectorAll('tr.detail-row').forEach((r) => r.remove());
    tbody.querySelectorAll('tr.track-row').forEach((r) => r.classList.remove('is-expanded'));

    if (isOpen) return; // it was open; we just closed it

    row.classList.add('is-expanded');
    const detail = document.createElement('tr');
    detail.className = 'detail-row';

    const cell = document.createElement('td');
    cell.colSpan = 7;

    const bits = [];
    if (item.bpm) bits.push(`<span><b>BPM</b> ${item.bpm}</span>`);
    if (item.musicalKey) bits.push(`<span><b>Key</b> ${item.musicalKey}</span>`);
    if (item.tags && item.tags.length) {
      bits.push(`<span><b>Tags</b> ${item.tags.join(', ')}</span>`);
    }
    if (item.isFree) {
      bits.push('<span><b>License</b> Free — use in any capacity</span>');
    } else if (item.licenses && item.licenses.length) {
      const tiers = item.licenses
        .map((t) => `${t.kind} $${(t.price_cents / 100).toFixed(0)}`)
        .join(' · ');
      bits.push(`<span><b>Licenses</b> ${tiers}</span>`);
    }
    if (!bits.length) bits.push('<span class="detail-empty">No extra details yet.</span>');

    cell.innerHTML = `<div class="track-detail">${bits.join('')}</div>`;
    detail.appendChild(cell);
    row.after(detail);
  }

  function buildRow(item, index) {
    const tr = document.createElement('tr');
    tr.className = 'track-row';
    tr.dataset.index = index;

    tr.innerHTML = `
      <td class="col-play"><button class="row-play" aria-label="Play ${item.title}">▶</button></td>
      <td class="col-title">${escapeHtml(item.title)}</td>
      <td class="col-artist">${escapeHtml(item.artist)}</td>
      <td class="col-price">${priceLabel(item)}</td>
      <td class="col-time" data-time>—</td>
      <td class="col-info"><button class="row-info" aria-label="More info">ⓘ</button></td>
      <td class="col-star"><button class="bookmark" aria-label="Bookmark">☆</button></td>`;

    tr.querySelector('.row-play').addEventListener('click', (e) => {
      e.stopPropagation();
      play(index);
    });
    tr.addEventListener('dblclick', () => play(index));

    tr.querySelector('.row-info').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleInfo(tr, item);
    });

    const star = tr.querySelector('.bookmark');
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = star.classList.toggle('starred');
      star.textContent = on ? '★' : '☆';
    });

    // Fill in duration once metadata loads (cached across rebuilds).
    const timeCell = tr.querySelector('[data-time]');
    fillDuration(item, timeCell);

    return tr;
  }

  function fillDuration(item, cell) {
    if (!item.audioUrl) return;
    if (durationCache.has(item.audioUrl)) {
      cell.textContent = fmtTime(durationCache.get(item.audioUrl));
      return;
    }
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      durationCache.set(item.audioUrl, audio.duration);
      cell.textContent = fmtTime(audio.duration);
    };
    audio.src = item.audioUrl;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function build() {
    tbody.innerHTML = '';
    beatBank.forEach((item, i) => tbody.appendChild(buildRow(item, i)));
  }

  build();

  window.beatList = {
    rebuild: build,
    markPlaying,
  };
})();
