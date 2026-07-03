# Third-party assets & notices

The MIT license in [LICENSE](LICENSE) covers the **code** in this repository. Media and 3D assets are handled as follows.

## Fetched at setup (not redistributed here)

| Asset | Source | License / terms |
|---|---|---|
| Photoreal base avatar (`avaturn-model`, Avaturn/RPM-compatible) | [met4citizen/talkinghead](https://github.com/met4citizen/talkinghead) | MIT (fetched by `apps/avatar-live/scripts/fetch-avatars.sh`) |
| Body-animation clips (`public/animations/*.glb`) | [Ready Player Me Animation Library](https://github.com/readyplayerme/animation-library) (Mixamo mocap retargeted to the RPM skeleton) | Free use incl. commercial **with RPM-compatible avatars**; redistribution prohibited — hence fetched by `apps/avatar-live/scripts/fetch-animations.sh`, never committed |
| Avatar recolor variants | generated locally from the base by `scripts/make-variants.sh` (needs Blender) | derivative of the MIT base |

## Bundled in the repo

| Asset | Source | License |
|---|---|---|
| `apps/avatar-live/public/avaturn-model/brown_photostudio_01.hdr` | [Poly Haven](https://polyhaven.com/a/brown_photostudio_01) | CC0 |
| `apps/avatar-live/public/samples/*` (newscast JSONs, slide imagery, music, clips) | generated for this project (studio renders / generative tooling) | project demo content — see `apps/avatar-live/public/samples/README.md` |
| `docs/media/*` (README GIFs/stills) | rendered by this studio | MIT with the repo |

If you believe an asset here infringes your rights, open an issue and it will be removed promptly.
