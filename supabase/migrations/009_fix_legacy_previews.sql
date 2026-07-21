-- beatbox — repair beats uploaded before previews existed
--
-- Run after 008_free_beats.sql. Idempotent.
--
-- Bug in the 007 backfill: it set preview_path = audio_path for existing
-- beats, reasoning that their audio was already public so it could serve
-- as its own preview.
--
-- That is true of the PATH but not of the BUCKET. 007 also flipped
-- beat-audio to private, and the client reads previews from
-- beat-previews. So the preview URL now points at a bucket where the file
-- does not exist, and those beats are silently unplayable.
--
-- Copying storage objects between buckets cannot be done in SQL. The
-- honest fix is to mark these beats as needing a preview and let the
-- normal pipeline regenerate one from the master, which is still safely
-- in beat-audio.

-- Only touch rows the 007 backfill created: paid beats whose preview and
-- master are the same path. A correctly generated preview never matches
-- its master, because generate-preview writes to "<id>-preview.mp3".
update public.beats
   set preview_state = 'pending',
       preview_path  = null,
       preview_mode  = 'platform',
       status        = 'draft',
       preview_error = null
 where not is_free
   and preview_path is not null
   and preview_path = audio_path;

-- Free beats are unaffected: their file legitimately lives in
-- beat-previews and is served clean, so preview_path = audio_path is
-- correct for them.

comment on column public.beats.preview_path is
  'Tagged preview in the PUBLIC beat-previews bucket. Never equal to
   audio_path for a paid beat — the master lives in a different, private
   bucket. Null until processing completes.';
