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

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { FFmpeg } from 'npm:@ffmpeg/ffmpeg@0.12.10';

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
 * ffmpeg filter: delay the tag to each placement, mix them all into the
 * beat. `duration=first` keeps the output the length of the beat rather
 * than extending to the last tag.
 */
async function laceTag(master: Uint8Array, tag: Uint8Array): Promise<Uint8Array> {
  const ffmpeg = new FFmpeg();
  await ffmpeg.load();

  await ffmpeg.writeFile('in.audio', master);
  await ffmpeg.writeFile('tag.audio', tag);

  // How long is the beat? Needed to know how many tags to place.
  const duration = await probeDuration(ffmpeg, 'in.audio');
  const placements: number[] = [];
  for (let t = TAG_INTERVAL; t < duration - 1; t += TAG_INTERVAL) {
    placements.push(t);
  }

  // A very short beat gets one tag at the start rather than none.
  if (placements.length === 0) placements.push(0);

  const delays = placements
    .map((t, i) => `[1:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},volume=${TAG_GAIN}[t${i}]`)
    .join(';');
  const inputs = placements.map((_, i) => `[t${i}]`).join('');

  const filter =
    `${delays};[0:a]${inputs}amix=inputs=${placements.length + 1}:duration=first:dropout_transition=0[out]`;

  await ffmpeg.exec([
    '-i', 'in.audio',
    '-i', 'tag.audio',
    '-filter_complex', filter,
    '-map', '[out]',
    '-b:a', '192k',
    'out.mp3',
  ]);

  const out = await ffmpeg.readFile('out.mp3');
  return out as Uint8Array;
}

async function probeDuration(ffmpeg: FFmpeg, file: string): Promise<number> {
  let seconds = 0;
  ffmpeg.on('log', ({ message }: { message: string }) => {
    const m = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) {
      seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    }
  });
  // ffmpeg writes duration to the log during any read of the file.
  await ffmpeg.exec(['-i', file, '-f', 'null', '-']);
  return seconds || 120;   // fall back to a sane default rather than zero
}

export { TAG_MAX_SEC };
