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

  // Two bars centred on the play circle (cx=49, cy=80.5), sized to sit
  // inside it with the same visual weight as the play triangle rather than
  // overspilling the circle. Bars 1.1 wide with a 0.7 gap → span 47.65–50.35.
  const pauseBar1 = document.createElementNS(NS, 'rect');
  const pauseBar2 = document.createElementNS(NS, 'rect');
  [[pauseBar1, 47.65], [pauseBar2, 49.25]].forEach(([bar, x]) => {
    bar.setAttribute('x',      x);
    bar.setAttribute('y',      '78.7');
    bar.setAttribute('width',  '1.1');
    bar.setAttribute('height', '3.6');
    bar.setAttribute('fill',   'black');
    bar.setAttribute('pointer-events', 'none');
    bar.style.display = 'none';
    bottomPanel.appendChild(bar);
  });

  // ── Waveform (SVG bars) ─────────────────────────────────────────────────────
  //
  // Drawn in the same SVG language as the rest of the deck, in the space
  // between the volume line and the transport buttons. The played portion
  // is filled; the rest is faint. Clicking seeks. Peaks come from the beat
  // (precomputed at upload); with none, a flat baseline is shown.

  const WF = {
    x0: 34, x1: 64,          // horizontal span in viewBox units
    yMid: 74,                // vertical centre — between the volume line
                             // (y=71) and the buttons (top ~76)
    maxH: 1.9,               // half-height of the tallest bar
    bars: 120,
    barW: 0.16,
  };

  const waveGroup = document.createElementNS(NS, 'g');
  waveGroup.setAttribute('class', 'waveform');
  // Append (not insert first): SVG paints in document order, so the group
  // must come AFTER the bottom-panel fill polygon or the white fill hides it.
  bottomPanel.appendChild(waveGroup);

  let waveBars = [];
  let currentPeaks = null;

  function renderWaveform(peaks) {
    currentPeaks = (peaks && peaks.length) ? peaks : null;
    waveGroup.innerHTML = '';
    waveBars = [];

    const n = WF.bars;
    const step = (WF.x1 - WF.x0) / n;

    for (let i = 0; i < n; i++) {
      // Map bar index to a peak (peaks may be a different length).
      let amp = 0.12; // flat baseline when there is no peak data
      if (currentPeaks) {
        const idx = Math.floor((i / n) * currentPeaks.length);
        amp = Math.max(0.06, currentPeaks[idx] || 0);
      }
      const h = amp * WF.maxH;
      const x = WF.x0 + i * step;

      const bar = document.createElementNS(NS, 'rect');
      bar.setAttribute('x', x.toFixed(3));
      bar.setAttribute('y', (WF.yMid - h).toFixed(3));
      bar.setAttribute('width', WF.barW);
      bar.setAttribute('height', (h * 2).toFixed(3));
      bar.setAttribute('class', 'wave-bar');
      bar.setAttribute('pointer-events', 'none');
      waveGroup.appendChild(bar);
      waveBars.push(bar);
    }
    paintProgress(0);
  }

  // Fill bars up to the current position; leave the rest faint.
  function paintProgress(fraction) {
    const cut = Math.floor(fraction * waveBars.length);
    waveBars.forEach((bar, i) => {
      bar.classList.toggle('is-played', i <= cut);
    });
  }

  // Click / drag anywhere on the waveform seeks.
  function seekFromEvent(e) {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const pt = toSVGPoint(e);
    const f = (pt.x - WF.x0) / (WF.x1 - WF.x0);
    audio.currentTime = Math.min(1, Math.max(0, f)) * audio.duration;
  }

  // A transparent hit strip over the waveform captures the clicks (the bars
  // themselves are pointer-events:none so thin gaps don't swallow clicks).
  const waveHit = document.createElementNS(NS, 'rect');
  waveHit.setAttribute('x', WF.x0);
  waveHit.setAttribute('y', WF.yMid - WF.maxH);
  waveHit.setAttribute('width', WF.x1 - WF.x0);
  waveHit.setAttribute('height', WF.maxH * 2);
  waveHit.setAttribute('fill', 'transparent');
  waveHit.style.cursor = 'pointer';
  waveHit.addEventListener('click', seekFromEvent);
  bottomPanel.appendChild(waveHit);

  renderWaveform(null);

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

    // Source priority:
    //   1. audioBlob — picked in this session, not yet uploaded
    //   2. audioUrl  — absolute URL from Supabase storage
    //   3. banks/…   — the original local file layout, for placeholder data
    let url;
    if (track.audioBlob) {
      url = URL.createObjectURL(track.audioBlob);
    } else if (track.audioUrl) {
      url = track.audioUrl;
    } else {
      url = `banks/${track.bank}/${track.file}`;
    }

    audio.src = url;
    audio.load();

    // Draw this track's waveform (or a flat baseline if it has no peaks).
    renderWaveform(track.peaks);
  }

  // ── Playback actions ─────────────────────────────────────────────────────────

  function togglePlay() {
    if (audio.paused) {
      if (!audio.src || audio.src === window.location.href) {
        loadTrack(currentTrack());
      }
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    // Icon follows the 'play'/'pause' events, so no manual switch here —
    // avoids the fresh-track load race that flipped it back.
  }

  function skip(dir) {
    const wasPlaying = !audio.paused;
    if (window.beatCarousel) {
      dir > 0 ? window.beatCarousel.next() : window.beatCarousel.prev();
    }
    loadTrack(currentTrack());
    if (wasPlaying) {
      audio.play().catch(() => {});
      // Icon follows the play/pause events.
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
    if (audio.duration) paintProgress(audio.currentTime / audio.duration);
  });

  audio.addEventListener('ended', () => skip(+1));

  // Drive the icon off the audio's own state, not the caller. This fixes a
  // race: play() calls loadTrack() → audio.load() → an async 'emptied'
  // event that fired AFTER play()'s showPauseIcon(), flipping it back to
  // the play icon on the first click of a fresh track. Listening to the
  // real playback events makes the icon authoritative regardless of order.
  audio.addEventListener('play',    showPauseIcon);
  audio.addEventListener('playing', showPauseIcon);
  audio.addEventListener('pause',   showPlayIcon);

  // ── Public API ────────────────────────────────────────────────────────────
  // Lets other views (the list) drive playback without re-implementing the
  // audio wiring or faking SVG clicks.

  window.beatTransport = {
    // Load whatever the carousel currently points at and start playing.
    // The list calls beatCarousel.goTo(i) first, so currentTrack() is right.
    play() {
      loadTrack(currentTrack());
      // Icon switches via the 'play'/'playing' listeners, so it only shows
      // pause once playback actually begins — not if play() is rejected.
      audio.play().catch(() => {});
    },
    toggle: togglePlay,
    pause() { audio.pause(); },
    get playing() { return !audio.paused; },
  };

})();
