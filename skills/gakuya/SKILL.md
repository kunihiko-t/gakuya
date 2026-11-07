---
name: gakuya
description: Use when a person is reviewing a rendered video in gakuya, or setting its lights with knobs in gakuya, and you act as the AI on the other side.
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
   - `event.type` is `note`, `yes`, `no`, `not_yet` or `settled` (see [Setting the lights live](#setting-the-lights-live)). `event.reason` is the person's optional line.
   - `note.frames` is the range they chose, roughly. `note.anchor` is the exact frame and the shape they drew, in 0..1 of the picture.
   - For each frame in `snapshots`, read both PNGs: `marked` shows where they pointed, `raw` shows the same frame without the mark. Look at them before you answer. The mark can cover the fault. A note written on the live picture shows that picture only on the frame that was on screen; its other frames come from the last render, with the old lighting.
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

## Setting the lights live

Some looks are hard to put into words: how bright, how glossy. For those the person looks at the real picture, moves a knob, and says "about this much". This needs a renderer: a program that draws the same picture as the final render, described in `docs/live-renderer.md`. For a big change of mood, skip the knobs and talk it through.

1. **Connect.** `gakuya <last render> --live http://127.0.0.1:<port>`, or `gakuya live <url>` for a review already running. The video still provides the frame count, and the sound and beats unless `--audio <file or video>` (or `--audio reference`) plays another sound in their place. If the renderer is not up yet, the page says so and connects once it is.

2. **Measure a value's whole range before you offer a knob.** A value can stop doing anything partway, and where it stops differs from frame to frame. A blur knob once did nothing over nine tenths of its travel on one frame. Step the value across its range on frames from several scenes, calling the renderer's `/knobs` and `/frame` yourself and comparing the pictures. The person's picture moves too, so do this while they are not watching, or tell them first. Then pick `min` and `max` from what you measured, and a `log` scale if equal travel should feel like equal change. If no `min` and `max` work on every frame, find what differs between the frames and change what the knob means in the renderer: lens blur differs with the focus distance, so a knob for the amount of blur works where one for the aperture cannot.

3. **Offer the knobs.** `gakuya knobs --file knobs.json` replaces what is on screen. Offer only what this conversation is about, and only what suits this stage: a knob that works on one stage can blow out or make no sense on another, so its range is measured per stage.

   ```json
   [
     { "id": "gloss", "label": "服の光沢", "min": 0, "max": 3, "default": 1, "scale": "linear", "scope": "global" },
     { "id": "hue", "label": "光の色", "min": 0, "max": 360, "default": null, "scale": "linear", "scope": "range", "reset": "場面どおりに戻す" }
   ]
   ```

   `global` acts on the whole song, for things like gloss and the character's brightness. `range` acts inside the range chosen on the timeline, for things like the light's color and the scene's brightness. `min` is the left end and may be the larger number. An ID the renderer does not know is refused: add it to the renderer first.

4. **Do not write the lighting settings until the event is `settled`.** Moving a knob tells you nothing, and nothing the person tries is meant yet. The output has `event`, `video` and `timing`.
   - `event.values` holds every knob on screen. `null` means they let go of it.
   - `event.frames` applies to `range` knobs only. If it is missing and a `range` knob matters, ask where it goes.
   - Use `timing` to turn frames and beats into each other. Changes land on the beat: done by the first beat of the range, back by the last. How many beats a change takes depends on the song, so propose it from the song and correct it in conversation.

5. **Write them, and show the result.** Write the values to the lighting settings and run `gakuya reload`. Then run `gakuya knobs` again, which puts every knob back at its default: for a `global` knob, make what you wrote the new default; for a `range` knob, use `null`, so that the settings you wrote are what shows and a value does not spread over the whole song. Then start the next `gakuya wait`.

6. **Render and hand it back.** After a note, use `gakuya done` as usual. When the work began in conversation, with no note, use `gakuya render --video <path>`. Either way the old and new versions sit side by side.
