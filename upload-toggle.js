// upload-toggle.js
//
// Shows/hides the upload window and gives it desktop-window behaviour:
// a title bar that drags it, and a close (✕) button. The sidebar upload
// icon still toggles it open/closed as before.
//
// Exposes window.uploadToggle.{open,close,toggle}. upload.js calls close()
// after a successful upload.

document.addEventListener('DOMContentLoaded', function () {
  const uploadBtn = document.querySelector('.btn.upload');
  const container = document.querySelector('.upload-container');
  const box       = container?.querySelector('.upload-container__box');
  const titlebar  = document.getElementById('uploadTitlebar');
  const closeBtn  = document.getElementById('uploadClose');

  if (!container || !box) return;

  container.style.display = 'none';

  function open() {
    container.style.display = 'flex';
  }

  function close() {
    container.style.display = 'none';
  }

  function toggle() {
    if (container.style.display === 'none') open();
    else close();
  }

  uploadBtn?.addEventListener('click', toggle);
  closeBtn?.addEventListener('click', close);

  // ── Dragging ───────────────────────────────────────────────────────────────
  // The box normally sits centred by the container's flex layout. On first
  // drag we switch it to absolute positioning at its current spot, then move
  // it with the pointer. Kept within the viewport so it can't be lost.

  let dragging = false;
  let startX = 0, startY = 0;   // pointer at drag start
  let baseX = 0, baseY = 0;     // box top-left at drag start
  let placed = false;           // has the box been positioned absolutely yet

  function beginPlacement() {
    const rect = box.getBoundingClientRect();
    // Break out of the centring flex layout into free positioning.
    container.style.alignItems = 'flex-start';
    container.style.justifyContent = 'flex-start';
    box.style.position = 'absolute';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.margin = '0';
    placed = true;
  }

  titlebar?.addEventListener('pointerdown', (e) => {
    // Don't start a drag from the close button.
    if (e.target.closest('.window-titlebar__close')) return;

    if (!placed) beginPlacement();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = box.getBoundingClientRect();
    baseX = rect.left;
    baseY = rect.top;
    titlebar.setPointerCapture(e.pointerId);
    titlebar.classList.add('is-dragging');
  });

  titlebar?.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // Keep the title bar reachable — clamp to the viewport with a margin.
    const maxX = window.innerWidth - 60;
    const maxY = window.innerHeight - 40;
    const nx = Math.min(Math.max(baseX + dx, -box.offsetWidth + 120), maxX);
    const ny = Math.min(Math.max(baseY + dy, 0), maxY);

    box.style.left = `${nx}px`;
    box.style.top = `${ny}px`;
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    titlebar.classList.remove('is-dragging');
    try { titlebar.releasePointerCapture(e.pointerId); } catch {}
  }
  titlebar?.addEventListener('pointerup', endDrag);
  titlebar?.addEventListener('pointercancel', endDrag);

  window.uploadToggle = { open, close, toggle };
});
