// carousel.js
//
// Renders beatBank (see beat-data.js) into .carousel-container as a
// coverflow-style carousel: the centered item sits flat, and items on
// either side are tilted in 3D (rotateY) and pushed back/scaled down,
// giving the impression of a wheel turning as you move through items.

(function () {
  const container = document.querySelector('.carousel-container');
  if (!container || typeof beatBank === 'undefined') return;

  const items = beatBank;
  let currentIndex = 0;

  // Tuning for the tilt/circular-motion effect
  const ANGLE = 32;        // rotateY per step away from center, degrees
  const SPACING_PCT = 24;  // horizontal offset per step, as % of container width
  const DEPTH_PCT = 18;    // pushed-back distance per step, as % of container width
  const SCALE_STEP = 0.18; // size reduction per step
  const MAX_VISIBLE = 3;   // items further than this fade out completely

  // Scroll/swipe acceleration: a small flick moves one item, a hard
  // flick jumps several at once.
  const WHEEL_STEP_PX = 35;   // deltaY per extra item jumped
  const MAX_WHEEL_STEPS = 8;  // cap on items per wheel event
  const WHEEL_LOCK_MS = 50;   // min gap between processed wheel events
  const SWIPE_STEP_PX = 60;   // swipe px per extra item jumped
  const MAX_SWIPE_STEPS = 8;  // cap on items per swipe

  function build() {
    container.innerHTML = '';

    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'carousel-item';
      el.dataset.bank = item.bank;
      el.dataset.file = item.file;

      const artwork = document.createElement('div');
      artwork.className = 'carousel-item__artwork';

      // If a real artwork file is provided, try to load it. If it fails
      // (or none is given yet), the placeholder pattern shows through.
      if (item.artwork) {
        const img = document.createElement('img');
        img.src = item.artwork;
        img.alt = item.title;
        img.onerror = () => img.remove();
        artwork.appendChild(img);
      }

      const title = document.createElement('div');
      title.className = 'carousel-item__title';
      title.textContent = item.title;

      const artist = document.createElement('div');
      artist.className = 'carousel-item__artist';
      artist.textContent = item.artist;

      el.append(artwork, title, artist);
      // Clicking any track centres it and starts it playing — one click, not
      // two. goTo() only plays the scroll sound when the index actually
      // changes, so clicking the already-centred item doesn't re-trigger it.
      el.addEventListener('click', () => {
        goTo(i);
        window.beatTransport?.play?.();
      });
      container.appendChild(el);
    });
  }

  // Shortest signed distance from i to currentIndex, wrapping around
  // both ends of the list so the motion reads as circular.
  function wrappedOffset(i, n) {
    let offset = i - currentIndex;
    if (offset > n / 2) offset -= n;
    if (offset < -n / 2) offset += n;
    return offset;
  }

  function update() {
    const els = container.querySelectorAll('.carousel-item');
    const n = els.length;

    const containerWidth = container.getBoundingClientRect().width;
    const spacing = containerWidth * (SPACING_PCT / 100);
    const depth = containerWidth * (DEPTH_PCT / 100);

    els.forEach((el, i) => {
      const offset = wrappedOffset(i, n);
      const abs = Math.abs(offset);

      const x = offset * spacing;
      const z = -abs * depth;
      const rotate = -offset * ANGLE;
      const scale = Math.max(1 - abs * SCALE_STEP, 0.4);

      el.style.transform =
        `translate(-50%, -50%) translateX(${x}px) translateZ(${z}px) rotateY(${rotate}deg) scale(${scale})`;
      el.style.zIndex = String(100 - abs);
      el.style.opacity = abs > MAX_VISIBLE ? '0' : String(Math.max(1 - abs * 0.2, 0));
      el.style.pointerEvents = abs > MAX_VISIBLE ? 'none' : 'auto';
      el.classList.toggle('is-active', offset === 0);
    });
  }

  // Plays once per item change. Rapid triggers (fast clicking/scrolling)
  // can fire before the previous play() has settled, so reusing one
  // Audio element and resetting currentTime would abort the in-flight
  // play and silently drop the sound. Cloning a fresh node per call lets
  // overlapping triggers play independently instead of racing.
  const scrollSound = new Audio('asset/sound/scroll.wav');
  function playScrollSound() {
    const sound = scrollSound.cloneNode();
    sound.play().catch(() => {});
  }

  function goTo(index) {
    const n = items.length;
    const newIndex = ((index % n) + n) % n;
    if (newIndex !== currentIndex) {
      playScrollSound();
    }
    currentIndex = newIndex;
    update();
  }

  function next() { goTo(currentIndex + 1); }
  function prev() { goTo(currentIndex - 1); }

  function isVisible() {
    return container.offsetWidth > 0 && container.offsetHeight > 0;
  }

  // Mouse wheel scrubs through items, with acceleration: harder/faster
  // scrolls jump multiple items at once.
  let wheelLock = false;
  container.addEventListener('wheel', (e) => {
    if (!isVisible()) return;
    e.preventDefault();
    if (wheelLock) return;
    wheelLock = true;

    const delta = e.deltaY || e.deltaX;
    const steps = Math.min(MAX_WHEEL_STEPS, Math.max(1, Math.round(Math.abs(delta) / WHEEL_STEP_PX)));

    if (delta > 0) goTo(currentIndex + steps); else goTo(currentIndex - steps);

    setTimeout(() => { wheelLock = false; }, WHEEL_LOCK_MS);
  }, { passive: false });

  // Touch swipe support, also accelerated by distance.
  let touchX = null;
  container.addEventListener('touchstart', (e) => {
    touchX = e.touches[0].clientX;
  });
  container.addEventListener('touchend', (e) => {
    if (touchX === null || !isVisible()) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) {
      const steps = Math.min(MAX_SWIPE_STEPS, Math.max(1, Math.round(Math.abs(dx) / SWIPE_STEP_PX)));
      dx < 0 ? goTo(currentIndex + steps) : goTo(currentIndex - steps);
    }
    touchX = null;
  });

  // Arrow keys, only act while the carousel is the visible view.
  document.addEventListener('keydown', (e) => {
    if (!isVisible()) return;
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
  });

  build();
  update();

  window.addEventListener('resize', update);

  // Exposed for other scripts (e.g. wiring up the transport prev/next
  // buttons, or triggering playback of the active item's bank/file).
  window.beatCarousel = {
    next,
    prev,
    goTo,
    rebuild() { build(); update(); },
    get currentIndex() { return currentIndex; }
  };
})();