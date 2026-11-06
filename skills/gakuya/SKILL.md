---
name: gakuya
description: Use when a person is reviewing a rendered video in gakuya and you act as the AI on the other side - receiving notes, confirming the spot on screen, fixing after a yes, and handing back the new render.
---

# Working with gakuya

gakuya is a local review page. A person stops a video, points at something, and writes a line. You read that note, show them on screen what you think they mean, and fix it only after they say yes.

You start it; the person does not. Run every command from the folder that holds `.gakuya/`. If several reviews are running, add `--review <name>`.

## Start

Run `gakuya <video>` with `run_in_background: true`. It opens the page in the browser and prints the link, so pass the link on in case the browser did not come to the front. Add `--reference <video>` if they gave you a video to compare with. Starting it again on the same video reuses the review and keeps its notes.

Then go straight to the loop. A long video takes a moment to copy, so if `gakuya wait` says nothing is running just after you started it, try again in a few seconds. When the person is finished, stop that background command.

## The loop

1. **Listen.** Run `gakuya wait` with `run_in_background: true`. It exits when something happens, and that exit wakes this session. Keep one running for as long as the review is open, and tell the person it is listening.

2. **Read what arrived.** The output is JSON with `event`, `note`, `snapshots` and `video`.
   - `event.type` is `note`, `yes`, `no` or `not_yet`. `event.reason` is the person's optional line.
   - `note.frames` is the range they chose, roughly. `note.anchor` is the exact frame and the shape they drew, in 0..1 of the picture.
   - For each frame in `snapshots`, read both PNGs: `marked` shows where they pointed, `raw` shows the same frame without the mark. Look at them before you answer. The mark can cover the fault.
   - `note.color` is a color they picked, if any.

3. **Confirm the spot.** Show them what you found:

   ```bash
   gakuya propose <note id> --frames 1218-1252 --region '[[0.61,0.56],[0.72,0.56],[0.74,0.62],[0.61,0.70]]' --text 'Here? Skin shows through the inside of the sleeve for these frames.'
   ```

   The range you give can be narrower or wider than theirs: say what you actually saw in the frames. Then start the next `gakuya wait`.

4. **Do not start fixing until the event is `yes`.** A note is not a go-ahead, and neither is a confident guess.
   - `no`: read `event.reason` and the new snapshots, since they may have pointed again. Propose again.
   - `yes`: now make the fix.

5. **Hand back the new render.**

   ```bash
   gakuya done <note id> --video <path to the new render>
   ```

   The page puts the old and new versions side by side on the same frame. Fix several notes in one render by calling `gakuya done` once per note with the same file.

6. **After each event, start the next `gakuya wait`.** `not_yet` means the fix did not hold: read the reason and go back to step 3 or 4 for that note. `resolved` sends nothing; it simply closes the note.

## Timing

If the page has the beat wrong, or you know where the moves should land, set it:

```bash
gakuya timing --bpm 128 --offset 0.18
gakuya timing --cues cues.json
```

`cues.json` is `[{ "time": 1.68, "label": "chorus" }]`, in seconds. When cues exist, the warm ring around the picture follows them instead of the beat.
