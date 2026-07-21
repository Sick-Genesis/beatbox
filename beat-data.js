// beat-data.js
//
// Placeholder data for the carousel. Each entry is one beat and the
// references it should eventually resolve to:
//
//   title / artist  -> displayed under the artwork in the carousel
//   artwork         -> path to a cover image. Leave null for now; the
//                      carousel falls back to a placeholder pattern.
//                      Later this can point at e.g. "banks/bank_01/art/001.jpg"
//   bank            -> id of the sample/beat bank this item belongs to
//   file            -> the specific file within that bank (e.g. an audio
//                      file) that this carousel item should call when
//                      selected/played

// Declared on window (not `const`) so the Supabase data layer in src/ can
// reach it. src/main.js replaces these placeholder rows in place once real
// beats load — see the note in src/beats-repo.js about why it must mutate
// this array rather than reassign it.
window.beatBank = [
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_01", file: "track_001.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_01", file: "track_002.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_01", file: "track_003.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_01", file: "track_004.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_02", file: "track_005.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_02", file: "track_006.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_02", file: "track_007.wav" },
  { title: "Track Title", artist: "Artist", artwork: null, bank: "bank_02", file: "track_008.wav" },
];
