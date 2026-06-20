# Audio2Face-3D wrapper (`services/gpu/a2f`)

HTTP front-end that turns speech audio into an **ARKit blendshape timeline** using
an NVIDIA **Audio2Face-3D** NIM, for the realtime browser avatar (`apps/avatar-live`).

```
browser (ServerA2FClient)  ──POST /a2f (wav)──▶  this FastAPI wrapper
                                                      │ gRPC
                                                      ▼
                                            Audio2Face-3D NIM (GPU)
                                                      │ animation stream
                           {names, frames:[{t,weights}]}  ◀── collected here
```

> Status: **scaffold.** The gRPC message construction mirrors NVIDIA's Apache-2.0
> reference client, but it has not been run in this repo (no GPU NIM here).
> Verify the controller endpoint/RPC name against your NIM deployment.

## 1. Deploy the A2F-3D NIM

Follow the quick-start in
[NVIDIA/Audio2Face-3D-Samples](https://github.com/NVIDIA/Audio2Face-3D-Samples)
(`quick-start/docker-compose.yml`). Requires an NVIDIA GPU + NGC access
(the A2F-3D models are gated under NVIDIA's license — check their terms).
Note the controller gRPC address (e.g. `localhost:52000`).

## 2. Generate the gRPC stubs

```bash
git clone https://github.com/NVIDIA/Audio2Face-3D-Samples
cd Audio2Face-3D-Samples/proto && ./build.sh        # → nvidia_ace.* python stubs
# put the generated package on PYTHONPATH for this wrapper
```

## 3. Run the wrapper

```bash
cd services/gpu/a2f
pip install -r requirements.txt
A2F_TARGET=localhost:52000 uvicorn app:app --host 0.0.0.0 --port 8095
```

On the H100 pod, add it to `supervisord.conf` and expose it via the nginx gateway
(alongside engine-three / TTS), then point the control-api / browser at it.

## 4. Point the browser at it

```bash
# apps/avatar-live/.env.development
VITE_A2F_URL=https://<pod-gateway>/a2f
```

The avatar app's **A2F lip-sync** badge will switch from `local stand-in` to
`NIM`, and the **A2F demo** / audio uploads will drive the avatar's full face
(jaw, visemes, brows, blinks, emotion) from real A2F-3D coefficients.

## Output contract

`POST /a2f` (body: `audio/wav`) returns:

```json
{ "names": ["jawOpen", "mouthFunnel", "mouthSmileLeft", ...],
  "frames": [ { "t": 0.0, "weights": [0.0, 0.1, ...] }, ... ] }
```

`names` are ARKit blendshape names; `weights` are index-aligned per frame; `t` is
seconds from the start. This is the exact shape `apps/avatar-live` expects
(`BlendshapeTimeline`), and matches A2F-3D's `SkelAnimationHeader.blend_shapes` +
`blend_shape_weights`.

## Attribution

gRPC request/response handling adapted from NVIDIA Audio2Face-3D-Samples
(Apache-2.0). The A2F-3D models/NIM are subject to NVIDIA's own license.
