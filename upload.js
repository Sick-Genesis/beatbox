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
  const bpmInput       = document.getElementById('trackBpm');
  const keyInput       = document.getElementById('trackKey');
  const tagsInput      = document.getElementById('trackTags');
  const rightsCheck    = document.getElementById('rightsWarrant');
  const rightsText     = document.getElementById('rightsWarrantText');
  const samplesCheck   = document.getElementById('containsSamples');
  const sampleNotes    = document.getElementById('sampleNotes');
  const sampleWrap     = document.getElementById('sampleNotesWrap');
  const statusEl       = document.getElementById('uploadStatus');
  const submitBtn      = document.getElementById('uploadSubmit');

  const freeCheck      = document.getElementById('isFree');
  const freeNote       = document.getElementById('freeNote');
  const previewMode    = document.getElementById('previewMode');
  const previewField   = previewMode?.closest('.upload-form__field');
  const tagZone        = document.getElementById('tagZone');
  const tagInput       = document.getElementById('tagFile');
  const tagFilename    = document.getElementById('tagFilename');
  const previewZone    = document.getElementById('previewZone');
  const previewInput   = document.getElementById('previewFile');
  const previewFilename = document.getElementById('previewFilename');

  let pendingAudio   = null;
  let pendingArtwork = null;
  let pendingTag     = null;
  let pendingPreview = null;

  // Only the input relevant to the chosen preview mode is shown. 'platform'
  // needs nothing extra, which is why it is the default. A free beat is
  // served clean, so the whole preview section goes away.
  function syncPreviewMode() {
    const free = !!freeCheck?.checked;
    const mode = previewMode?.value || 'platform';

    if (previewField) previewField.style.display = free ? 'none' : 'flex';
    if (tagZone) {
      tagZone.style.display = (!free && mode === 'own_tag') ? 'block' : 'none';
    }
    if (previewZone) {
      previewZone.style.display = (!free && mode === 'supplied') ? 'block' : 'none';
    }

    // Say plainly that this cannot be undone — the file goes out publicly
    // and copies cannot be recalled.
    if (freeNote) {
      freeNote.textContent = free
        ? 'Anyone can use it commercially, forever, no credit needed. You keep '
          + 'ownership, but the full file is public — you cannot take it back '
          + 'from anyone who has it. Free beats have no price and cannot be traded.'
        : '';
    }
  }

  freeCheck?.addEventListener('change', syncPreviewMode);
  previewMode?.addEventListener('change', syncPreviewMode);
  syncPreviewMode();

  // ── Tag and preview pickers ──
  function wireFilePicker(zone, input, filenameEl, onPick) {
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      onPick(file);
      if (filenameEl) filenameEl.textContent = file.name;
      zone.classList.add('has-file');
    });

    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      onPick(file);
      if (filenameEl) filenameEl.textContent = file.name;
      zone.classList.add('has-file');
    });
  }

  wireFilePicker(tagZone, tagInput, tagFilename, f => { pendingTag = f; });
  wireFilePicker(previewZone, previewInput, previewFilename, f => { pendingPreview = f; });

  // Show the full warranty wording the uploader is agreeing to, taken from
  // the same constant that gets stored on the beat. Keeping one source
  // means the checkbox can never say something different from the record.
  //
  // main.js is a deferred module, so window.beatboxApi does not exist yet
  // when this classic script runs. Poll briefly rather than reading once.
  (function fillWarranty(attempt = 0) {
    const text = window.beatboxApi?.RIGHTS_WARRANTY_TEXT;
    if (text && rightsText) {
      rightsText.textContent = text;
      return;
    }
    if (attempt < 40) setTimeout(() => fillWarranty(attempt + 1), 50);
  })();

  // Sample details only matter if samples were declared.
  function syncSampleNotes() {
    if (sampleWrap) {
      sampleWrap.style.display = samplesCheck?.checked ? 'flex' : 'none';
    }
  }
  samplesCheck?.addEventListener('change', syncSampleNotes);
  syncSampleNotes();

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

  submitBtn.addEventListener('click', async () => {
    if (!pendingAudio) {
      flashError(audioZone);
      setStatus('Choose an audio file first.', true);
      return;
    }

    const api = window.beatboxApi;

    // No backend configured — keep the original local-only behaviour so
    // the prototype still demos without Supabase.
    if (!api?.isConfigured) {
      addLocally();
      return;
    }

    if (!rightsCheck?.checked) {
      setStatus('Confirm you hold the rights before uploading.', true);
      return;
    }

    const session = await api.getSession();
    if (!session) {
      setStatus('Sign in to upload a beat.', true);
      return;
    }

    submitBtn.disabled = true;
    setStatus('Uploading…');

    try {
      // Accepting the rights warranty is what makes someone a producer.
      // First upload promotes the account rather than turning it away.
      if (!session.isProducer) {
        setStatus('Setting up your producer account…');
        await api.becomeProducer(api.RIGHTS_WARRANTY_TEXT);
      }

      const beat = await api.createBeat({
        audioFile:   pendingAudio,
        artworkFile: pendingArtwork,
        title:       trackNameInput.value.trim(),
        artist:      artistInput.value.trim(),
        bpm:         bpmInput?.value.trim() || null,
        musicalKey:  keyInput?.value.trim() || '',
        tags:        parseTags(tagsInput?.value),
        rightsWarranted: true,
        containsSamples: !!samplesCheck?.checked,
        sampleNotes:     sampleNotes?.value || '',
        previewMode:     previewMode?.value || 'platform',
        tagFile:         pendingTag,
        previewFile:     pendingPreview,
        isFree:          !!freeCheck?.checked,
      });

      // A free beat is served clean and publishes immediately. A paid one
      // stays draft until the preview is generated server-side.
      if (freeCheck?.checked) {
        setStatus('');
        window.uploadToggle?.close?.();
      } else {
        setStatus('Preparing your preview…');
        const state = await api.awaitPreview(beat.id);

        if (state === 'processing') {
          setStatus('Still processing — it will appear once it is ready.');
        } else {
          setStatus('');
          window.uploadToggle?.close?.();
        }
      }

      // Re-fetch so the new beat arrives with its server-side id and URLs
      // rather than being faked into the array locally.
      await api.reloadBeats();
      resetForm();
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      submitBtn.disabled = false;
    }
  });

  /** Original behaviour: push a blob-backed entry straight into beatBank. */
  function addLocally() {
    const entry = {
      title:     trackNameInput.value.trim() || 'untitled',
      artist:    artistInput.value.trim()    || 'unknown',
      artwork:   pendingArtwork ? URL.createObjectURL(pendingArtwork) : null,
      bank:      'uploads',
      file:      pendingAudio.name,
      audioBlob: pendingAudio,
    };

    if (typeof beatBank !== 'undefined') beatBank.push(entry);
    window.beatCarousel?.rebuild?.();

    resetForm();
    window.uploadToggle?.close?.();
  }

  /** "trap, dark, 808" → ["trap","dark","808"], deduped and lowercased. */
  function parseTags(raw) {
    if (!raw) return [];
    return [...new Set(
      raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    )];
  }

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('is-error', isError);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function resetForm() {
    trackNameInput.value = '';
    artistInput.value    = '';
    if (bpmInput)     bpmInput.value = '';
    if (keyInput)     keyInput.value = '';
    if (tagsInput)    tagsInput.value = '';
    if (sampleNotes)  sampleNotes.value = '';
    if (rightsCheck)  rightsCheck.checked = false;
    if (samplesCheck) samplesCheck.checked = false;
    syncSampleNotes();
    setStatus('');
    audioFilename.textContent = '';
    audioLabel.textContent    = 'drop audio or click';
    audioZone.classList.remove('has-file');
    artworkPreview.style.display = 'none';
    artworkPreview.src = '';
    if (artworkHolder) artworkHolder.style.display = 'block';
    pendingAudio   = null;
    pendingArtwork = null;
    pendingTag     = null;
    pendingPreview = null;
    audioInput.value = '';

    if (tagInput)        tagInput.value = '';
    if (previewInput)    previewInput.value = '';
    if (tagFilename)     tagFilename.textContent = '';
    if (previewFilename) previewFilename.textContent = '';
    tagZone?.classList.remove('has-file');
    previewZone?.classList.remove('has-file');
    if (previewMode) previewMode.value = 'platform';
    if (freeCheck)   freeCheck.checked = false;
    syncPreviewMode();
  }

  function flashError(el) {
    el.classList.add('error');
    setTimeout(() => el.classList.remove('error'), 700);
  }
})();
