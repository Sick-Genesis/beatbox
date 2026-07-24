// filter-ui.js
//
// The filter panel opened from the header's funnel icon. Reads/writes
// window.filterCriteria (see filter-state.js) and re-renders both views on
// every change. Markup built in JS, same pattern as auth-ui.js; styling
// lives in filter.css.

(function () {
  let panel = null;

  function rebuildViews() {
    window.beatFilters?.apply?.();
    window.beatCarousel?.rebuild?.();
    window.beatList?.rebuild?.();
    updateDot();
  }

  function updateDot() {
    const dot = document.querySelector('.filter-toggle__dot');
    if (dot) dot.style.display = window.beatFilters?.active ? '' : 'none';
  }

  function tagChip(tag, active) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `filter-chip${active ? ' is-active' : ''}`;
    b.textContent = tag;
    b.addEventListener('click', () => {
      const tags = window.filterCriteria.tags;
      if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
      b.classList.toggle('is-active');
      rebuildViews();
    });
    return b;
  }

  function build() {
    panel = document.createElement('div');
    panel.id = 'filter-panel';
    panel.className = 'filter-panel';

    const tags = window.beatFilters?.allTags?.() || [];
    const tagsHtml = tags.length
      ? ''
      : '<p class="filter-empty">No tags in the catalog yet.</p>';

    panel.innerHTML = `
      <div class="filter-panel__bar">
        <span>filter</span>
        <button type="button" class="filter-panel__reset">reset</button>
      </div>
      <div class="filter-panel__body">
        <div class="filter-section">
          <div class="filter-section__label">tags</div>
          <div class="filter-chips" id="filter-tag-chips">${tagsHtml}</div>
        </div>

        <div class="filter-section">
          <div class="filter-section__label">price</div>
          <div class="filter-toggle-row" id="filter-free-toggle">
            <button type="button" class="filter-option is-active" data-value="all">all</button>
            <button type="button" class="filter-option" data-value="free">free</button>
            <button type="button" class="filter-option" data-value="paid">paid</button>
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section__label">bpm</div>
          <div class="filter-range-row">
            <input type="number" inputmode="numeric" placeholder="min" id="filter-bpm-min"/>
            <span>–</span>
            <input type="number" inputmode="numeric" placeholder="max" id="filter-bpm-max"/>
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section__label">price ($)</div>
          <div class="filter-range-row">
            <input type="number" inputmode="numeric" placeholder="min" id="filter-price-min"/>
            <span>–</span>
            <input type="number" inputmode="numeric" placeholder="max" id="filter-price-max"/>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const chipHost = panel.querySelector('#filter-tag-chips');
    tags.forEach((t) => chipHost.appendChild(tagChip(t, false)));

    panel.querySelector('.filter-panel__reset').addEventListener('click', () => {
      window.beatFilters?.reset?.();
      panel.querySelectorAll('.filter-chip.is-active').forEach((c) => c.classList.remove('is-active'));
      panel.querySelectorAll('.filter-option').forEach((b) => b.classList.toggle('is-active', b.dataset.value === 'all'));
      panel.querySelector('#filter-bpm-min').value = '';
      panel.querySelector('#filter-bpm-max').value = '';
      panel.querySelector('#filter-price-min').value = '';
      panel.querySelector('#filter-price-max').value = '';
      rebuildViews();
    });

    panel.querySelectorAll('#filter-free-toggle .filter-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('#filter-free-toggle .filter-option').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        window.filterCriteria.free = btn.dataset.value;
        rebuildViews();
      });
    });

    const numberInput = (id, key) => {
      const input = panel.querySelector(id);
      input.addEventListener('input', () => {
        const v = input.value.trim();
        window.filterCriteria[key] = v === '' ? null : Number(v);
        rebuildViews();
      });
    };
    numberInput('#filter-bpm-min', 'bpmMin');
    numberInput('#filter-bpm-max', 'bpmMax');
    numberInput('#filter-price-min', 'priceMin');
    numberInput('#filter-price-max', 'priceMax');
  }

  function toggle() {
    if (!panel) build();
    panel.classList.toggle('is-open');
  }

  // Docked to the top-right corner, clear of the list/carousel container
  // (which starts at 21.5% down the layout — anchoring the panel under the
  // header icon at y=17% would sit right on top of it, so a click meant for
  // a track underneath would hit the panel instead). Below the auth bar,
  // same corner-docking pattern as chat-panel/auth-bar elsewhere.
  function position() {
    if (!panel) return;
    panel.style.left = 'auto';
    panel.style.right = '12px';
    panel.style.top = '48px';
  }

  document.addEventListener('DOMContentLoaded', () => {
    const icon = document.querySelector('.filter-toggle');
    icon?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
      position();
    });
    window.addEventListener('resize', position);

    document.addEventListener('click', (e) => {
      if (panel?.classList.contains('is-open') && !panel.contains(e.target) && !icon.contains(e.target)) {
        panel.classList.remove('is-open');
      }
    });
  });
})();
