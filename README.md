# Live Avatar Stream 3D

> **What this repo is now (2026-06-26):** a **browser-based 3D talking-avatar studio**
> (`apps/avatar-live`) — author a performance script, the browser renders a lip-synced 3D
> avatar in real time and exports an MP4 client-side. A Cloudflare control plane handles voice
> cloning, avatar assets, and persistence. The earlier server-render paths (engine-three) were
> removed; the 2D + realtime paths were relocated to `../LiveAvatarStream`. See `CLAUDE.md` and
> `docs/specs/2026-06-25-performance-score-dsl-design.md`. The original product brief is below.

---

I want to create a backend processor and webapp where webapp creates avatar by generated image or uploaded image, then using the avatar + script creates a animated avatar video like heygen does. then adds voice to the videos. step 2 and 3 can be done at once and voice can be created while creating avatar using audio cloning using uploaded voice sample or recording voice on the fly. backend does all the voice cloning, storing the cloned voice weights to cloudflare's bucket, generating audio+video using script input having all gesture, posture, emotion information to make avatar do what's there in video. this is supposed to be a opensource avatar video generation tool with ability to generate realtime stream of avatar talking with user in realtime with voice input and video going out at the same time. backend should be hosted on cloudflare. create product spec and technical architecture document and plan to get this built. we're okey to use opensource tech like deepfake, etc or other prominent techs  or okey to train models as well. generation speed with highest quality is important here.