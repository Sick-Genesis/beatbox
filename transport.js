// transport.js
//
// Wires the SVG transport controls to HTML5 audio playback.
//
// Play/pause  — circle at cx=49, cy=80.5 (and the play triangle next to it)
// Prev / Next — circles at cx=42 and cx=56, cy=80.5
// Volume      — the existing #slider-knob drag (cx maps 42→56 to vol 0→1)
// Time        — text injected into the time rect at y=86
//
// Track source priority:
//   1. entry.audioBlob  (uploaded in this session)
//   2. banks/<bank>/<file>  (file-based, for later backend wiring)

(function () {
  const NS  = 'http://www.w3.org/2000/svg';
  const svgEl = document.querySelector('svg.layout');
  if (!svgEl) return;

  // ── Audio engine ────────────────────────────────────────────────────────────

  const audio = new Audio();
  audio.volume = 0.5; // knob starts at cx=49, midpoint of 42–56

  // ── SVG element references ──────────────────────────────────────────────────

  const bottomPanel  = svgEl.querySelector('.bottom-panel');

  // Play triangle — the polygon immediately after the play circle in the SVG
  const playTriangle = (() => {
    const circle = svgEl.querySelector('.play-pause');
    let el = circle ? circle.nextElementSibling : null;
    while (el && el.tagName.toLowerCase() !== 'polygon') el = el.nextElementSibling;
    return el;
  })();

  // ── Inject pause bars (hidden until playing) ────────────────────────────────

  const pauseBar1 = document.createElementNS(NS, 'rect');
  const pauseBar2 = document.createElementNS(NS, 'rect');
  [[pauseBar1, 47.2], [pauseBar2, 50.3]].forEach(([bar, x]) => {
    bar.setAttribute('x',      x);
    bar.setAttribute('y',      '78.5');
    bar.setAttribute('width',  '1.8');
    bar.setAttribute('height', '4');
    bar.setAttribute('fill',   'black');
    bar.setAttribute('pointer-events', 'none');
    bar.style.display = 'none';
    bottomPanel.appendChild(bar);
  });

  // ── Inject time text into the time rect ─────────────────────────────────────

  const timeText = document.createElementNS(NS, 'text');
  timeText.setAttribute('x',           '49');
  timeText.setAttribute('y',           '88.4');
  timeText.setAttribute('text-anchor', 'middle');
  timeText.setAttribute('font-size',   '2');
  timeText.setAttribute('fill',        '#555');
  timeText.setAttribute('font-family', '-apple-system, Helvetica Neue, sans-serif');
  timeText.setAttribute('pointer-events', 'none');
  timeText.textContent = '0:00 / 0:00';
  bottomPanel.appendChild(timeText);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function fmt(s) {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    const m   = Math.floor(s / 60);
    const sec = String(Math.floor(s % 60)).padStart(2, '0');
    return `${m}:${sec}`;
  }

  function showPlayIcon() {
    if (playTriangle) playTriangle.style.display = '';
    pauseBar1.style.display = 'none';
    pauseBar2.style.display = 'none';
  }

  function showPauseIcon() {
    if (playTriangle) playTriangle.style.display = 'none';
    pauseBar1.style.display = '';
    pauseBar2.style.display = '';
  }

  function currentTrack() {
    const idx = (window.beatCarousel ? window.beatCarousel.currentIndex : 0);
    return (typeof beatBank !== 'undefined' && beatBank[idx]) ? beatBank[idx] : null;
  }

  function loadTrack(track) {
    if (!track) return;
    const url = track.audioBlob
      ? URL.createObjectURL(track.audioBlob)
      : `banks/${track.bank}/${track.file}`;
    audio.src = url;
    audio.load();
  }

  // ── Playback actions ─────────────────────────────────────────────────────────

  function togglePlay() {
    if (audio.paused) {
      if (!audio.src || audio.src === window.location.href) {
        loadTrack(currentTrack());
      }
      audio.play().catch(() => {});
      showPauseIcon();
    } else {
      audio.pause();
      showPlayIcon();
    }
  }

  function skip(dir) {
    const wasPlaying = !audio.paused;
    if (window.beatCarousel) {
      dir > 0 ? window.beatCarousel.next() : window.beatCarousel.prev();
    }
    loadTrack(currentTrack());
    if (wasPlaying) {
      audio.play().catch(() => {});
      showPauseIcon();
    }
  }

  // ── Click detection via SVG coordinates ─────────────────────────────────────
  // The arrow graphics are siblings of the circles, not children, so normal
  // click listeners on the circles miss clicks on the arrows. SVG coordinate
  // math handles the full hit area for each button regardless of what's clicked.

  function toSVGPoint(e) {
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svgEl.getScreenCTM().inverse());
  }

  svgEl.addEventListener('click', e => {
    const p    = toSVGPoint(e);
    const dist = (cx, cy) => Math.hypot(p.x - cx, p.y - cy);

    if (dist(49, 80.5) <= 4.5) { togglePlay(); return; }
    if (dist(42, 80.5) <= 3.5) { skip(-1);     return; }
    if (dist(56, 80.5) <= 3.5) { skip(+1);     return; }
  });

  // ── Volume — observe slider-knob cx attribute ────────────────────────────────

  const sliderKnob = document.getElementById('slider-knob');
  const VOL_MIN = 42, VOL_MAX = 56;

  function syncVolume() {
    const cx  = parseFloat(sliderKnob.getAttribute('cx'));
    audio.volume = Math.max(0, Math.min(1, (cx - VOL_MIN) / (VOL_MAX - VOL_MIN)));
  }

  new MutationObserver(syncVolume)
    .observe(sliderKnob, { attributes: true, attributeFilter: ['cx'] });

  syncVolume(); // init from starting knob position

  // ── Time display ─────────────────────────────────────────────────────────────

  audio.addEventListener('timeupdate', () => {
    timeText.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
  });

  audio.addEventListener('ended', () => skip(+1));
  audio.addEventListener('pause', showPlayIcon);

  // When a new track is loaded from the carousel without using transport
  // buttons (e.g. clicking a carousel item), reset the icon state.
  audio.addEventListener('emptied', showPlayIcon);

})();
