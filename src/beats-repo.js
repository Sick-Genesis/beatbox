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

const AUDIO_BUCKET = 'beat-audio';
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

    // transport.js builds `banks/<bank>/<file>` when there is no audioBlob.
    // Providing an absolute audioUrl lets it skip that path construction.
    audioUrl: publicUrl(AUDIO_BUCKET, row.audio_path),
    bank: row.producer_id,
    file: row.audio_path,

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
    // claim is untradable whatever else is true of it.
    tradable: row.status !== 'sold_exclusive' && !row.withdrawn_at,

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
      id, producer_id, rights_holder_id, title, artist, audio_path, artwork_path,
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
export const RIGHTS_WARRANTY_TEXT =
  'I confirm I created this beat or otherwise hold the rights to license ' +
  'and trade it, that any third-party samples it contains have been ' +
  'cleared, and that licensing it through beatbox does not infringe ' +
  "anyone else's rights.";

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

  const audioUpload = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(audioPath, audioFile, { upsert: false });

  if (audioUpload.error) {
    throw new Error(`Audio upload failed: ${audioUpload.error.message}`);
  }

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
    }
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
    })
    .select()
    .single();

  if (insertError) {
    // Don't leave an orphaned file in storage behind a failed row.
    await supabase.storage.from(AUDIO_BUCKET).remove([audioPath]);
    if (artworkPath) {
      await supabase.storage.from(ARTWORK_BUCKET).remove([artworkPath]);
    }
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

  return toBeatBankEntry({ ...beat, license_tiers: [] });
}

/** Current session user, or null. */
export async function currentUser() {
  if (!isConfigured) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}
