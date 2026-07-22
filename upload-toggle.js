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
    // Capture the box's current on-screen position, then lift it OUT of the
    // scroll/overflow container into fixed, viewport-relative positioning.
    // Fixed coords match clientX/clientY exactly, so the drag tracks the
    // pointer 1:1 instead of fighting the container's coordinate space —
    // that mismatch was the "acting weird" jank.
    const rect = box.getBoundingClientRect();
    container.style.alignItems = 'flex-start';
    container.style.justifyContent = 'flex-start';
    box.style.position = 'fixed';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.margin = '0';
    box.style.zIndex = '10001';
    placed = true;
  }

  titlebar?.addEventListener('pointerdown', (e) => {
    // Don't start a drag from the close button.
    if (e.target.closest('.window-titlebar__close')) return;
    e.preventDefault();

    if (!placed) beginPlacement();
    dragging = true;
    // Offset of the pointer WITHIN the box, so the box moves relative to
    // the grab point rather than snapping its corner to the cursor.
    const rect = box.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    titlebar.setPointerCapture(e.pointerId);
    titlebar.classList.add('is-dragging');
  });

  titlebar?.addEventListener('pointermove', (e) => {
    if (!dragging) return;

    // New top-left = pointer minus the grab offset. Pure fixed coords.
    let nx = e.clientX - startX;
    let ny = e.clientY - startY;

    // Keep the title bar on-screen: never let the window leave more than
    // its width minus a reachable strip, and never go above the top.
    const w = box.offsetWidth;
    nx = Math.min(Math.max(nx, -(w - 120)), window.innerWidth - 60);
    ny = Math.min(Math.max(ny, 0), window.innerHeight - 30);

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
