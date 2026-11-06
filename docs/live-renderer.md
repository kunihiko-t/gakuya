# The live renderer contract

gakuya does not draw. For `gakuya <video> --live <url>`, another program draws the picture and answers the four calls below. Any engine will do. The test suite has a small fake one in `tests/live.test.ts`.

Listen on loopback only. gakuya accepts no other address. It relays the page's calls, and keeps its token, cookies, `Origin` and `Referer` to itself, so a request from gakuya has no `Origin`. Refuse any request that has one from another site: a web page open in the same browser can otherwise reach this port.

## `GET /info`

```json
{ "fps": 30, "frames": 1146, "width": 1080, "height": 1920, "knobs": ["gloss", "hue", "level"] }
```

`fps` and `frames` must match the video, or the page says so and will not go live: a range is a pair of frame numbers, and they have to mean the same picture. `knobs` lists every ID this renderer can act on. `gakuya knobs` refuses any other, so nobody is handed a knob that does nothing. gakuya checks this call once a second, and shows that the renderer stopped when it fails.

## `GET /frame?after=<id>`

Answer with the newest picture whose ID is above `after`, as a JPEG:

| Header | Value |
|---|---|
| `X-Frame-Id` | The picture's ID. Counts up. |
| `X-Song-Frame` | The frame of the song this picture shows. |
| `X-Knob-Seq` | The `seq` of the last `POST /knobs` this picture reflects. |

If no newer picture appears within about a second, answer `204`. Skip frames rather than fall behind: the sound does not wait. The page reads one picture at a time.

## `POST /knobs`

The whole state, each time. Answer `200` with any JSON.

```json
{
  "seq": 512,
  "values": { "gloss": 1.4, "blur": null },
  "rangeValues": { "hue": 185 },
  "range": [480, 592],
  "paused": false,
  "seek": 486
}
```

- `values`: knobs that act on the whole song, even while a range is chosen.
- `rangeValues`: knobs that act inside `range`, or on the whole song when `range` is `null`. At the edges of the range the picture changes at once. The musical transition comes later, from the settings the agent writes.
- A value replaces the setting; it is never a multiplier. `null` lets go, back to what the settings say.
- `paused`: whether the song's clock runs. While it runs, advance by your own clock.
- `seek`: a frame to jump to, or `null` to stay where you are. The page brings you back when you wander more than half a second from the sound, and at the end of a range, since a range repeats.
- `seq` is a 32-bit integer that only goes up. Echo it in `X-Knob-Seq` exactly: a picture with an older number is thrown away as out of date.

## `POST /reload`

Read the lighting settings again, and answer `200` with any JSON once they are in effect. The body is `{}`. Run by `gakuya reload` after the agent has written them. gakuya never reads those settings, so their format is yours.
