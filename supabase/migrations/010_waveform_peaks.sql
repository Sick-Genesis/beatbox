-- beatbox — waveform peaks
--
-- Run after 009_fix_legacy_previews.sql. Idempotent.
--
-- Stores a small array of amplitude peaks per beat so the transport can
-- draw a waveform instantly, without downloading and decoding the audio
-- first. Peaks are extracted in the browser at upload time (the same place
-- the tag is laced in), so the server does no audio work.
--
-- Shape: a JSON array of small numbers in 0..1, one per waveform bar
-- (~120 bars). This is a few hundred bytes — cheap to store on the row and
-- return with every beat, no separate fetch.

alter table public.beats
  add column if not exists peaks jsonb;

comment on column public.beats.peaks is
  'Normalised waveform amplitudes (0..1), one per bar, for the transport
   display. ~120 values. Null for beats uploaded before waveforms, and for
   any upload where extraction failed — the UI falls back to a flat bar.';
