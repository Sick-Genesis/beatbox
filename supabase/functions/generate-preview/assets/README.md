# platform-tag.mp3 — required

The default voice tag laced into previews when a producer picks
"add a beatbox tag" (the default preview mode).

**This file is not in the repo — you need to supply it.** Without it,
`generate-preview` fails for every beat in `platform` mode, and those
beats stay in draft rather than publishing. That is the intended failure
direction, but it means nothing publishes until this exists.

## What to record

- **1–2 seconds.** Long enough to be unmistakable, short enough not to
  bury the beat. Producer tags in this market are almost always under
  two seconds.
- **Something spoken.** A voice is far harder to filter out than a tone,
  and it doubles as branding the way "Metro Boomin want some more" does.
- **Mixed a little quiet.** The function applies `TAG_GAIN = 0.8`
  already; record it clean rather than loud.
- **MP3, mono is fine.** Save as `platform-tag.mp3` in this folder.

## Placement

`generate-preview` overlays it every `TAG_INTERVAL` seconds — 15 by
default, set in `index.ts`. A three-minute beat gets roughly eleven
placements.

The point is not to be unremovable. It is to make the preview useless as
a finished track, so paying is easier than stealing.
