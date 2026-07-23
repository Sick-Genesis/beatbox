// aspect-fix.js
// The layout SVG uses viewBox="0 0 100 100" with preserveAspectRatio="none",
// stretching non-uniformly to fill the viewport whenever it isn't square.
// That's fine for panels/backgrounds, but it turns circular buttons (play,
// prev, next, icons) into ellipses. Elements marked ".keep-aspect" get an
// inverse counter-scale (around their own center, given by data-cx/data-cy
// in viewBox units) so they render as originally drawn regardless of
// window aspect ratio.

(function () {
  const svg = document.querySelector('svg.layout');
  if (!svg) return;

  function applyAspectFix() {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // viewBox is 100x100, so the stretch ratio is just rendered width/height.
    const sx = rect.width / 100;
    const sy = rect.height / 100;
    if (!sx || !sy) return;

    // Counter-scale to undo the stretch, normalized so icons keep a
    // consistent on-screen size (scaled to the smaller stretch factor).
    const base = Math.min(sx, sy);
    const fx = base / sx;
    const fy = base / sy;

    document.querySelectorAll('.keep-aspect').forEach(el => {
      const cx = el.dataset.cx;
      const cy = el.dataset.cy;
      if (cx === undefined || cy === undefined) return;
      el.style.transformBox = 'view-box';
      el.style.transformOrigin = `${cx}px ${cy}px`;
      el.style.transform = `scale(${fx}, ${fy})`;
    });

    // The volume knob is a special case: it must stay round, but its X
    // position is meaningful (it slides), so it can't be counter-scaled
    // horizontally around a fixed origin — that would drag it back toward
    // centre and stop it reaching the track ends. Scale it on Y only, around
    // its live centre, so it renders circular without distorting its travel.
    // A Y-only scale, so the horizontal origin is irrelevant (X is untouched)
    // and the transform needn't update as the knob slides. cy=71 is fixed.
    const knob = document.getElementById('slider-knob');
    if (knob) {
      knob.style.transformBox = 'view-box';
      knob.style.transformOrigin = `49px 71px`;
      knob.style.transform = `scale(1, ${fy / fx})`;
    }
  }

  window.addEventListener('resize', applyAspectFix);
  window.addEventListener('DOMContentLoaded', applyAspectFix);
  applyAspectFix();
})();
