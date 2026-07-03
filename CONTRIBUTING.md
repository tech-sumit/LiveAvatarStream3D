# Contributing

Thanks for looking! This project is young and moving fast — issues, ideas, and PRs are all welcome.

## Dev setup

```bash
npm install            # also builds @las/performer-core's dist (its `prepare` script)
bash apps/avatar-live/scripts/fetch-avatars.sh      # avatar models (not redistributed in-repo)
bash apps/avatar-live/scripts/fetch-animations.sh   # gesture/locomotion clips
npm run dev:avatar     # the studio → http://localhost:5175
npm run typecheck      # all workspaces
npm test               # unit tests (protocol, performer-core, avatar-live, control-api)
```

Node ≥ 20. After every pull, run `npm install` again — `@las/performer-core` emits a gitignored `dist/` that the other workspaces need.

## Ground rules

- **Branch + PR** — pushing to `main` is blocked. CI (typecheck + tests) must be green.
- **Direction is data.** Prefer extending the data catalogs (camera shots, gestures, DSL vocabularies) over adding imperative special cases — see the [Score/Stage design spec](docs/specs/2026-06-25-performance-score-dsl-design.md).
- **DSL vocabularies live in `packages/protocol`** — regenerate the JSON schema after changing them: `npm run protocol:schema`.
- **No silent retries** on render/recording jobs — failures should surface loudly.
- New behavior needs a unit test where one is practical (vitest; see the existing `*.test.ts`).

## Good first contributions

- **Camera presets** — [`packages/performer-core/src/cameraShots.ts`](packages/performer-core/src/cameraShots.ts) is a data table; a new framing is a row, not engine code.
- **Gesture clips** — Mixamo-retargeted additions to the gesture set.
- **Stage & chrome styling** — lighting rigs, wall/ticker/slide themes.
- **Docs** — anything that confused you is a doc bug; PR the fix.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, browser + OS, and console output if there is any. A short screen capture is gold.
