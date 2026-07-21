// generate-preview — lace a tag into a beat and publish the result
//
// Runs server-side because the clean master must never reach the browser.
// Doing this client-side would mean handing the client the very file the
// preview exists to protect.
//
// Called after upload with a beat id. Reads the clean master from the
// private bucket, overlays a tag every TAG_INTERVAL seconds, writes the
// result to the public preview bucket, and flips the beat to published.
//
// The beat stays 'draft' until this succeeds. If it fails the beat simply
// never publishes — the safe direction to fail in, since the alternative
// is a listed beat with an unprotected clean file.
//
// Deploy:
//   supabase functions deploy generate-preview
//
// Requires the platform tag at supabase/functions/generate-preview/
// assets/platform-tag.mp3 (see README in that folder).

// ⚠ AUDIO PROCESSING DOES NOT RUN HERE — see laceTag() at the bottom.
//
// Hosted Supabase Edge Functions cannot transcode audio:
//   - Deno.Command is blocked, so there is no ffmpeg binary to invoke
//   - ffmpeg.wasm is a browser build (Worker + SharedArrayBuffer) and its
//     core alone is tens of MB, past the 256 MB memory ceiling
//
// This function is still the right place for the ORCHESTRATION — reading
// the master, deciding the mode, publishing on success — but the actual
// tagging has to happen in a container that has ffmpeg. laceTag() is the
// seam: point it at that worker.
//
// Until then only preview_mode 'supplied' completes, and free beats,
// which skip this path entirely.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const TAG_INTERVAL = 15;    // seconds between tag placements
const TAG_MAX_SEC = 3;      // producer tags longer than this are rejected
const TAG_GAIN = 0.8;       // tag volume relative to the beat

interface Payload {
  beatId: string;
}

Deno.serve(async (req) => {
  // Service role: this function needs to read the private bucket and
  // write columns the uploading user cannot write themselves.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let beatId: string | undefined;

  try {
    const body: Payload = await req.json();
    beatId = body.beatId;
    if (!beatId) throw new Error('beatId is required.');

    const { data: beat, error } = await supabase
      .from('beats')
      .select('id, producer_id, audio_path, tag_path, preview_mode, preview_state')
      .eq('id', beatId)
      .single();

    if (error || !beat) throw new Error('Beat not found.');

    // Already done, or in flight from a duplicate call.
    if (beat.preview_state === 'ready') {
      return json({ ok: true, alreadyReady: true });
    }

    await supabase
      .from('beats')
      .update({ preview_state: 'processing', preview_error: null })
      .eq('id', beatId);

    // ── supplied: the producer gave us a preview already ──
    //
    // Nothing is verified here. We cannot tell a tagged file from a clean
    // one, so this mode trusts the producer with their own beat. Their
    // file, their risk.
    if (beat.preview_mode === 'supplied') {
      if (!beat.preview_path) {
        throw new Error('No preview file was supplied.');
      }
      await publish(supabase, beatId);
      return json({ ok: true, mode: 'supplied' });
    }

    // ── Fetch the clean master ──
    const master = await download(supabase, 'beat-audio', beat.audio_path);

    // ── Pick the tag ──
    let tag: Uint8Array;
    if (beat.preview_mode === 'own_tag') {
      if (!beat.tag_path) throw new Error('No tag file was uploaded.');
      tag = await download(supabase, 'beat-tags', beat.tag_path);
    } else {
      tag = await platformTag();
    }

    // ── Lace it in ──
    const tagged = await laceTag(master, tag);

    const previewPath = `${beat.producer_id}/${beatId}-preview.mp3`;
    const up = await supabase.storage
      .from('beat-previews')
      .upload(previewPath, tagged, {
        contentType: 'audio/mpeg',
        upsert: true,
      });

    if (up.error) throw new Error(`Preview upload failed: ${up.error.message}`);

    await supabase
      .from('beats')
      .update({ preview_path: previewPath })
      .eq('id', beatId);

    await publish(supabase, beatId);

    return json({ ok: true, mode: beat.preview_mode, previewPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Record why, and leave the beat unpublished.
    if (beatId) {
      await supabase
        .from('beats')
        .update({ preview_state: 'failed', preview_error: message })
        .eq('id', beatId);
    }

    return json({ ok: false, error: message }, 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function download(supabase: any, bucket: string, path: string) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(`Could not read ${bucket}/${path}: ${error.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

async function platformTag(): Promise<Uint8Array> {
  const url = new URL('./assets/platform-tag.mp3', import.meta.url);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** Mark the preview ready and publish. The DB trigger verifies both. */
async function publish(supabase: any, beatId: string) {
  const { error } = await supabase
    .from('beats')
    .update({ preview_state: 'ready', status: 'published' })
    .eq('id', beatId);

  if (error) throw new Error(`Could not publish: ${error.message}`);
}

/**
 * Overlay `tag` onto `master` every TAG_INTERVAL seconds.
 *
 * NOT IMPLEMENTED HERE — see the note at the top of this file. Edge
 * Functions cannot run ffmpeg, so this delegates to a worker that can.
 *
 * Set TAGGER_URL and TAGGER_SECRET to a service that accepts the master
 * and tag and returns the mixed audio. Anything with ffmpeg works:
 * Fly.io, Cloud Run, Railway, a Lambda container.
 *
 * The filter graph that service should apply — delay a copy of the tag to
 * each placement, then mix them all into the beat. `duration=first` keeps
 * the output the length of the beat rather than extending to the last tag:
 *
 *   [1:a]adelay=15000|15000,volume=0.8[t0];
 *   [1:a]adelay=30000|30000,volume=0.8[t1];
 *   ...
 *   [0:a][t0][t1]...amix=inputs=N:duration=first:dropout_transition=0[out]
 */
async function laceTag(master: Uint8Array, tag: Uint8Array): Promise<Uint8Array> {
  const taggerUrl = Deno.env.get('TAGGER_URL');

  if (!taggerUrl) {
    throw new Error(
      'Preview tagging is not configured yet. Set TAGGER_URL to a service '
      + 'that can run ffmpeg, or upload your own tagged preview instead.'
    );
  }

  const form = new FormData();
  form.append('master', new Blob([master]));
  form.append('tag', new Blob([tag]));
  form.append('intervalSeconds', String(TAG_INTERVAL));
  form.append('tagGain', String(TAG_GAIN));

  const res = await fetch(taggerUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('TAGGER_SECRET') ?? ''}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Tagging service failed: ${res.status} ${await res.text()}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

export { TAG_MAX_SEC, TAG_INTERVAL, TAG_GAIN };
