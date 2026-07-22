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
const ARTWORK_BUCKET = 'beat-artwork';

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

    // Waveform amplitudes for the transport display, or null → flat bar.
    peaks: Array.isArray(row.peaks) ? row.peaks : null,

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
      is_free, free_terms, peaks,
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
 *   'own_tag'  — producer supplies a short tag (length checked in tagger.js)
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
  previewFile = null,   // the finished, browser-tagged preview (paid beats)
  isFree = false,
  peaks = null,         // waveform amplitudes, extracted in the browser
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

  // ── Preview ──
  //
  // For a paid beat the tagged preview is made in the BROWSER before this
  // runs (see src/tagger.js) and arrives here as previewFile — whether the
  // producer picked the platform tag, their own tag, or supplied a
  // finished preview. So there is a single path: upload the finished
  // preview to the public bucket. No server processing, no tag bucket.
  //
  // Free beats have no preview file; the clean public upload is served
  // directly.

  let previewPath = null;
  if (!isFree) {
    if (!previewFile) {
      await cleanUp(uploaded);
      throw new Error('The preview could not be prepared. Try again, or upload your own tagged preview.');
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

      // The preview already exists — tagged in the browser for paid beats,
      // or the clean file itself for free ones — so beats publish
      // immediately. The beats_require_preview trigger still guards this:
      // it refuses to publish without a ready preview.
      status: 'published',
      preview_mode: isFree ? 'supplied' : previewMode,
      preview_path: isFree ? audioPath : previewPath,
      preview_state: 'ready',

      is_free: isFree,
      free_terms: isFree ? FREE_TERMS_TEXT : null,
      free_since: isFree ? new Date().toISOString() : null,

      peaks,
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

  // No server-side processing: the preview is already made and uploaded.
  return toBeatBankEntry({ ...beat, license_tiers: [] });
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

/** Current session user, or null. */
export async function currentUser() {
  if (!isConfigured) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}
