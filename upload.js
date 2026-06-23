// upload.js
// Drives the upload form inside .upload-container__box:
//   - Artwork zone: drag-drop or click → shows preview in place
//   - Audio zone:   drag-drop or click → accepts .wav / .mp3
//   - Track name + artist text inputs
//   - Submit: pushes entry into beatBank and triggers carousel rebuild

(function () {
  const artworkZone    = document.getElementById('artworkZone');
  const artworkPreview = document.getElementById('artworkPreview');
  const artworkHolder  = document.querySelector('.artwork-placeholder');
  const audioZone      = document.getElementById('audioZone');
  const audioInput     = document.getElementById('audioFile');
  const audioLabel     = document.getElementById('audioLabel');
  const audioFilename  = document.getElementById('audioFilename');
  const trackNameInput = document.getElementById('trackName');
  const artistInput    = document.getElementById('artistName');
  const submitBtn      = document.getElementById('uploadSubmit');

  let pendingAudio   = null;
  let pendingArtwork = null;

  // ── Artwork zone ──────────────────────────────────────────────────────────

  function applyArtwork(file) {
    if (!file || !file.type.startsWith('image/')) return;
    pendingArtwork = file;
    artworkPreview.src = URL.createObjectURL(file);
    artworkPreview.style.display = 'block';
    if (artworkHolder) artworkHolder.style.display = 'none';
  }

  artworkZone.addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.onchange = e => applyArtwork(e.target.files[0]);
    picker.click();
  });

  artworkZone.addEventListener('dragover',  e => { e.preventDefault(); artworkZone.classList.add('drag-over'); });
  artworkZone.addEventListener('dragleave', ()  => artworkZone.classList.remove('drag-over'));
  artworkZone.addEventListener('drop', e => {
    e.preventDefault();
    artworkZone.classList.remove('drag-over');
    applyArtwork(e.dataTransfer.files[0]);
  });

  // ── Audio zone ────────────────────────────────────────────────────────────

  function applyAudio(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['wav', 'mp3'].includes(ext)) {
      flashError(audioZone);
      return;
    }
    pendingAudio = file;
    audioLabel.textContent = 'audio file';
    audioFilename.textContent = file.name;
    audioZone.classList.add('has-file');
  }

  audioZone.addEventListener('click',    () => audioInput.click());
  audioInput.addEventListener('change',  e  => applyAudio(e.target.files[0]));

  audioZone.addEventListener('dragover',  e => { e.preventDefault(); audioZone.classList.add('drag-over'); });
  audioZone.addEventListener('dragleave', ()  => audioZone.classList.remove('drag-over'));
  audioZone.addEventListener('drop', e => {
    e.preventDefault();
    audioZone.classList.remove('drag-over');
    applyAudio(e.dataTransfer.files[0]);
  });

  // ── Submit ────────────────────────────────────────────────────────────────

  submitBtn.addEventListener('click', () => {
    if (!pendingAudio) {
      flashError(audioZone);
      return;
    }

    const entry = {
      title:     trackNameInput.value.trim() || 'untitled',
      artist:    artistInput.value.trim()    || 'unknown',
      artwork:   pendingArtwork ? URL.createObjectURL(pendingArtwork) : null,
      bank:      'uploads',
      file:      pendingAudio.name,
      audioBlob: pendingAudio,
    };

    if (typeof beatBank !== 'undefined') {
      beatBank.push(entry);
    }

    // Tell the carousel to re-render with the new entry
    if (window.beatCarousel && typeof window.beatCarousel.rebuild === 'function') {
      window.beatCarousel.rebuild();
    }

    resetForm();

    // Close the overlay if upload-toggle exposes a close method
    if (window.uploadToggle && typeof window.uploadToggle.close === 'function') {
      window.uploadToggle.close();
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function resetForm() {
    trackNameInput.value = '';
    artistInput.value    = '';
    audioFilename.textContent = '';
    audioLabel.textContent    = 'drop audio or click';
    audioZone.classList.remove('has-file');
    artworkPreview.style.display = 'none';
    artworkPreview.src = '';
    if (artworkHolder) artworkHolder.style.display = 'block';
    pendingAudio   = null;
    pendingArtwork = null;
    audioInput.value = '';
  }

  function flashError(el) {
    el.classList.add('error');
    setTimeout(() => el.classList.remove('error'), 700);
  }
})();
