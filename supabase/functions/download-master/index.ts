// download-master — release a clean master to someone entitled to it
//
// The clean file lives in a private bucket and is never publicly
// reachable. This is the only way out of that bucket: it checks
// entitlement via can_download_master() and mints a short-lived signed
// URL.
//
// Entitlement is decided in Postgres, not here, so the rule lives in one
// place and cannot drift between callers.
//
// Deploy:
//   supabase functions deploy download-master

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL_TTL_SECONDS = 300;   // 5 minutes — long enough to start a download

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Sign in to download.' }, 401);
    }

    // Two clients on purpose:
    //   userClient  — carries the caller's JWT, so auth.uid() resolves to
    //                 them and can_download_master() judges the right person
    //   adminClient — service role, needed to sign a URL in a private bucket
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: auth } = await userClient.auth.getUser();
    if (!auth?.user) return json({ error: 'Sign in to download.' }, 401);

    const { beatId } = await req.json();
    if (!beatId) return json({ error: 'beatId is required.' }, 400);

    // Entitlement check runs as the caller.
    const { data: allowed, error: checkError } = await userClient
      .rpc('can_download_master', { p_beat_id: beatId });

    if (checkError) {
      return json({ error: `Could not verify access: ${checkError.message}` }, 500);
    }
    if (!allowed) {
      // Deliberately vague: do not confirm the beat exists to someone with
      // no claim on it.
      return json({ error: 'You do not have a license for this beat.' }, 403);
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: beat, error: beatError } = await adminClient
      .from('beats')
      .select('audio_path, title')
      .eq('id', beatId)
      .single();

    if (beatError || !beat) return json({ error: 'Beat not found.' }, 404);

    const { data: signed, error: signError } = await adminClient.storage
      .from('beat-audio')
      .createSignedUrl(beat.audio_path, URL_TTL_SECONDS, {
        download: `${beat.title || 'beat'}.${beat.audio_path.split('.').pop()}`,
      });

    if (signError) {
      return json({ error: `Could not prepare download: ${signError.message}` }, 500);
    }

    return json({ url: signed.signedUrl, expiresIn: URL_TTL_SECONDS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
