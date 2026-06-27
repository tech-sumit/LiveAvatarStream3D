# Generated renders

The canonical home for **every exported video** from the studio (WebCodecs MP4 export,
1080p/4K). Always save renders here — don't leave them in `~/Downloads`.

> The video blobs themselves are **gitignored** (50 MB+ each — wrong fit for git). Only this
> README and `.gitignore` are tracked. Treat the folder as a local artifact store; copy a clip
> elsewhere (R2, a release) if it needs to be shared.

## Naming convention

```
<YYYY-MM-DD>-<topic-slug>-<resolution>[-<variant>].mp4
```

- **date** — the render date (`2026-06-27`).
- **topic-slug** — kebab-case, matches the source `*.newscast.json` slug where there is one
  (`gpt56-rollout`, `fable-mythos-access`).
- **resolution** — `1080p` or `4k`.
- **variant** — optional qualifier when the same newscast is rendered more than one way
  (`calm`, `lively`, `take2`, …). Omit when there's only one.

### Examples

| File | What it is |
|---|---|
| `2026-06-27-gpt56-rollout-1080p.mp4` | GPT-5.6 rollout newscast, calm anchor (`idleMotion: false`), slide deck |
| `2026-06-27-fable-mythos-access-1080p.mp4` | Fable/Mythos access-suspension newscast |

The studio's own export downloads as `avatar-take (N).mp4` — rename to the convention above
when you move it here.
