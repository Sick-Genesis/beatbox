// beats-repo.js
//
// The data layer between Supabase and the existing front-end scripts.
//
// The one constraint that shapes this file: carousel.js captures the
// beatBank array by reference at IIFE time (`const items = beatBank`), and
// transport.js reads the global directly. So the array must be MUTATED IN
// PLACE — reassigning window.beatBank would leave the carousel rendering a
// detached copy forever. Hence `syncInto()` splices rather than assigns.

import { supabase, isConfigured } from './supabase-client.js';

const AUDIO_BUCKET = 'beat-audio';       // private — clean masters
const PREVIEW_BUCKET = 'beat-previews';  // public  — tagged previews
const TAG_BUCKET = 'beat-tags';          // private — producer tags
const ARTWORK_BUCKET = 'beat-artwork';

/** Producer tags longer than this are rejected. Matches the Edge Function. */
export const TAG_MAX_SECONDS = 3;

/**
 * Turn a storage path into a playable URL.
 * Paths are stored, not URLs, so the bucket can become private later
 * (signed URLs after purchase) without touching any stored rows.
 */
function publicUrl(bucket, path) {
  if (!path || !supabase) return null;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

/**
 * Map a database row to the shape the existing scripts already expect.
 * Keeping this shape identical is what lets carousel.js and transport.js
 * work unchanged against real data.
 */
function toBeatBankEntry(row) {
  return {
    id: row.id,
    title: row.title || 'untitled',
    artist: row.artist || 'unknown',
    artwork: publicUrl(ARTWORK_BUCKET, row.artwork_path),

    // What plays is ALWAYS the tagged preview. The clean master lives in a
    // private bucket and only leaves it through the download-master
    // function, after an entitlement check.
    audioUrl: publicUrl(PREVIEW_BUCKET, row.preview_path),
    bank: row.producer_id,
    file: row.preview_path,

    previewState: row.preview_state,
    previewMode: row.preview_mode,

    isFree: row.is_free ?? false,
    freeTerms: row.free_terms ?? null,

    bpm: row.bpm,
    musicalKey: row.musical_key,
    tags: row.tags || [],

    // Creator credit vs current rights holder. These are equal until the
    // beat is traded away; after that producerId still names who made it
    // and rightsHolderId names who controls it. The trade UI needs both.
    producerId: row.producer_id,
    rightsHolderId: row.rights_holder_id,
    status: row.status,
    withdrawnAt: row.withdrawn_at,
    containsSamples: row.contains_samples,

    // Withdrawal is independent of status: a beat pulled under a rights
    // claim is untradable whatever else is true of it. Free beats have no
    // scarcity to exchange, so they are excluded too — matching the RLS
    // policy, which refuses such offers outright.
    tradable: row.status !== 'sold_exclusive'
      && !row.withdrawn_at
      && !row.is_free,

    licenses: (row.license_tiers || [])
      .slice()
      .sort((a, b) => a.price_cents - b.price_cents),
  };
}

/** Fetch published beats, newest first, with their license tiers. */
export async function fetchBeats({ limit = 100 } = {}) {
  if (!isConfigured) return [];

  const { data, error } = await supabase
    .from('beats')
    .select(`
      id, producer_id, rights_holder_id, title, artist, artwork_path,
      preview_path, preview_state, preview_mode,
      is_free, free_terms,
      bpm, musical_key, tags, duration_sec, status, created_at,
      withdrawn_at, contains_samples,
      license_tiers ( id, kind, price_cents, currency, deliverable, terms )
    `)
    .neq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[beatbox] Could not load beats:', error.message);
    return [];
  }

  return (data || []).map(toBeatBankEntry);
}

/**
 * Replace the contents of the live beatBank array in place.
 * See the note at the top of this file for why this is not an assignment.
 */
export function syncInto(targetArray, entries) {
  targetArray.splice(0, targetArray.length, ...entries);
  return targetArray;
}

/**
 * Upload audio + optional artwork, then insert the beat and its license
 * tiers. Requires an authenticated user — storage policies key the upload
 * path on auth.uid().
 */
/**
 * The wording an uploader affirms. Stored verbatim on each beat, because
 * proving what someone agreed to requires the text they saw, not a
 * boolean. Changing this creates a new warranty going forward; beats
 * uploaded earlier keep the wording they were shown.
 *
 * This is scaffolding, not legal cover — real terms of service are
 * separate work.
 */
/**
 * The wording a producer agrees to when giving a beat away. Snapshotted
 * onto the beat, like the rights warranty, because it will change.
 *
 * The two clauses that matter: the producer keeps ownership, and the
 * grant cannot be taken back from anyone who already has it.
 */
export const FREE_TERMS_TEXT =
  'I am giving this beat away: anyone may use it in any capacity, ' +
  'including commercially, forever, with no fee and no credit required. ' +
  'I keep ownership and may stop offering it later, but I cannot revoke ' +
  'it from anyone who has already taken it. The full file will be ' +
  'publicly downloadable, so this cannot be undone in practice.';

export const RIGHTS_WARRANTY_TEXT =
  'I confirm I created this beat or otherwise hold the rights to license ' +
  'and trade it, that any third-party samples it contains have been ' +
  'cleared, and that licensing it through beatbox does not infringe ' +
  "anyone else's rights.";

/**
 * Upload a beat.
 *
 * The clean master always goes to the private bucket. How the public
 * preview is made depends on previewMode:
 *
 *   'platform' — beatbox laces in its own tag (default)
 *   'own_tag'  — producer supplies a short tag (<= TAG_MAX_SECONDS)
 *   'supplied' — producer supplies a finished, already-tagged preview
 *
 * The beat is created as a DRAFT and only publishes once its preview
 * exists — a database trigger enforces that, so a bug here cannot leave a
 * clean file listed publicly.
 */
export async function createBeat({
  audioFile,
  artworkFile,
  title,
  artist,
  bpm,
  musicalKey,
  tags = [],
  licenses = [],
  rightsWarranted = false,
  containsSamples = null,
  sampleNotes = '',
  previewMode = 'platform',
  tagFile = null,
  previewFile = null,
  isFree = false,
}) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  const { data: auth } = await supabase.auth.getUser();
  const user = auth?.user;
  if (!user) throw new Error('You need to be signed in to upload a beat.');
  if (!audioFile) throw new Error('An audio file is required.');

  // Enforced here and again at settlement: a beat with no rights
  // declaration cannot be traded. Blocking at upload gives the clearer
  // error, since that's where the person can actually fix it.
  if (!rightsWarranted) {
    throw new Error(
      'You need to confirm you hold the rights to this beat before uploading it.'
    );
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const audioExt = audioFile.name.split('.').pop().toLowerCase();
  const audioPath = `${user.id}/${stamp}.${audioExt}`;

  // A free beat is served clean, so its file goes straight to the public
  // preview bucket — there is nothing to withhold. Paid beats keep their
  // master private and stream a tagged copy instead.
  const masterBucket = isFree ? PREVIEW_BUCKET : AUDIO_BUCKET;

  const audioUpload = await supabase.storage
    .from(masterBucket)
    .upload(audioPath, audioFile, { upsert: false });

  if (audioUpload.error) {
    throw new Error(`Audio upload failed: ${audioUpload.error.message}`);
  }

  // Track everything uploaded so a later failure can clean up after itself.
  const uploaded = [[masterBucket, audioPath]];

  let artworkPath = null;
  if (artworkFile) {
    const artExt = artworkFile.name.split('.').pop().toLowerCase();
    artworkPath = `${user.id}/${stamp}.${artExt}`;
    const artUpload = await supabase.storage
      .from(ARTWORK_BUCKET)
      .upload(artworkPath, artworkFile, { upsert: false });

    // Artwork is optional — a failure here shouldn't lose the audio upload.
    if (artUpload.error) {
      console.warn('[beatbox] Artwork upload failed:', artUpload.error.message);
      artworkPath = null;
    } else {
      uploaded.push([ARTWORK_BUCKET, artworkPath]);
    }
  }

  // ── Preview inputs ──
  //
  // These are what the Edge Function works from. The preview itself is
  // generated server-side, except in 'supplied' mode where the producer
  // has already made one.

  let tagPath = null;
  if (!isFree && previewMode === 'own_tag') {
    if (!tagFile) {
      await cleanUp(uploaded);
      throw new Error('Upload a tag, or let beatbox add one for you.');
    }

    const seconds = await audioDuration(tagFile);
    if (seconds > TAG_MAX_SECONDS + 0.25) {   // small tolerance for encoding
      await cleanUp(uploaded);
      throw new Error(`Tags need to be ${TAG_MAX_SECONDS} seconds or shorter.`);
    }

    const tagExt = tagFile.name.split('.').pop().toLowerCase();
    tagPath = `${user.id}/${stamp}-tag.${tagExt}`;
    const tagUpload = await supabase.storage
      .from(TAG_BUCKET)
      .upload(tagPath, tagFile, { upsert: false });

    if (tagUpload.error) {
      await cleanUp(uploaded);
      throw new Error(`Tag upload failed: ${tagUpload.error.message}`);
    }
    uploaded.push([TAG_BUCKET, tagPath]);
  }

  let previewPath = null;
  if (!isFree && previewMode === 'supplied') {
    if (!previewFile) {
      await cleanUp(uploaded);
      throw new Error('Upload your tagged preview, or let beatbox make one.');
    }

    const pvExt = previewFile.name.split('.').pop().toLowerCase();
    previewPath = `${user.id}/${stamp}-preview.${pvExt}`;
    const pvUpload = await supabase.storage
      .from(PREVIEW_BUCKET)
      .upload(previewPath, previewFile, { upsert: false });

    if (pvUpload.error) {
      await cleanUp(uploaded);
      throw new Error(`Preview upload failed: ${pvUpload.error.message}`);
    }
    uploaded.push([PREVIEW_BUCKET, previewPath]);
  }

  const { data: beat, error: insertError } = await supabase
    .from('beats')
    .insert({
      producer_id: user.id,
      // Creator and rights holder start as the same person; they diverge
      // only when the beat is traded away.
      rights_holder_id: user.id,
      title: title?.trim() || 'untitled',
      artist: artist?.trim() || null,
      audio_path: audioPath,
      artwork_path: artworkPath,
      bpm: bpm ? Number(bpm) : null,
      musical_key: musicalKey?.trim() || null,
      tags,

      rights_warranted_at: new Date().toISOString(),
      rights_warranty_text: RIGHTS_WARRANTY_TEXT,
      contains_samples: containsSamples,
      sample_notes: sampleNotes?.trim() || null,

      // Free beats need no processing: the clean file is the preview, so
      // they publish immediately. Paid beats stay draft until the Edge
      // Function produces a tagged preview — the beats_require_preview
      // trigger refuses to publish without one.
      status: isFree ? 'published' : 'draft',
      preview_mode: isFree ? 'supplied' : previewMode,
      preview_path: isFree ? audioPath : previewPath,
      preview_state: isFree ? 'ready' : 'pending',
      tag_path: tagPath,

      is_free: isFree,
      free_terms: isFree ? FREE_TERMS_TEXT : null,
      free_since: isFree ? new Date().toISOString() : null,
    })
    .select()
    .single();

  if (insertError) {
    await cleanUp(uploaded);
    throw new Error(`Could not save beat: ${insertError.message}`);
  }

  if (licenses.length) {
    const { error: tierError } = await supabase.from('license_tiers').insert(
      licenses.map((l) => ({
        beat_id: beat.id,
        kind: l.kind,
        price_cents: Math.round(Number(l.price) * 100),
        deliverable: l.deliverable || 'mp3',
        terms: l.terms || null,
      }))
    );
    if (tierError) {
      console.warn('[beatbox] License tiers not saved:', tierError.message);
    }
  }

  // Free beats are already live — nothing to tag.
  if (!isFree) {
    // Deliberately not awaited beyond dispatch: the beat is safely a draft
    // either way, and making the producer wait on ffmpeg would block the
    // form for no benefit.
    const { error: fnError } = await supabase.functions.invoke('generate-preview', {
      body: { beatId: beat.id },
    });

    if (fnError) {
      console.warn('[beatbox] Preview generation could not start:', fnError.message);
    }
  }

  return toBeatBankEntry({ ...beat, license_tiers: [] });
}

/**
 * Poll until a beat's preview finishes processing.
 *
 * Returns the final state. Callers use this to tell a producer when their
 * upload has gone live, since publication happens server-side.
 */
export async function awaitPreview(beatId, { timeoutMs = 120000 } = {}) {
  if (!isConfigured) return 'ready';

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const { data } = await supabase
      .from('beats')
      .select('preview_state, preview_error')
      .eq('id', beatId)
      .single();

    if (data?.preview_state === 'ready') return 'ready';
    if (data?.preview_state === 'failed') {
      throw new Error(data.preview_error || 'Preview could not be generated.');
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  return 'processing';   // still going; not an error, just slow
}

/**
 * Get a time-limited download link for a clean master.
 * Entitlement is decided server-side by can_download_master().
 */
export async function getMasterDownloadUrl(beatId) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase.functions.invoke('download-master', {
    body: { beatId },
  });

  if (error) throw new Error('Could not prepare the download.');
  if (data?.error) throw new Error(data.error);

  return data.url;
}

/**
 * Take a free beat.
 *
 * Recorded as a licence like any other, so a user's library is one list
 * however each item was acquired, and so there is evidence of what terms
 * applied on the day it was taken. Claiming twice is harmless — the
 * existing licence is returned.
 */
export async function claimFreeBeat(beatId) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase.rpc('claim_free_beat', {
    p_beat_id: beatId,
  });

  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
  return data;
}

/** Remove uploaded objects after a failure, so nothing is orphaned. */
async function cleanUp(uploaded) {
  for (const [bucket, path] of uploaded) {
    try {
      await supabase.storage.from(bucket).remove([path]);
    } catch {
      // Best effort — the original error matters more than this one.
    }
  }
}

/** Read a file's duration by loading it into an <audio> element. */
function audioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';

    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };

    audio.onloadedmetadata = () => done(audio.duration || 0);
    // Unreadable metadata shouldn't block an upload — let the server decide.
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

/** Current session user, or null. */
export async function currentUser() {
  if (!isConfigured) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}
