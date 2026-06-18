"""Single-input CLI wrapper around the EchoMimicV3-preview pipeline.

Upstream's ``infer_preview.py`` hard-codes a batch of demo inputs and has no CLI,
so this thin wrapper reproduces its exact pipeline + chunked long-video loop for
one (image, audio, prompt) triple and writes one mp4. It imports the upstream
``src.*`` modules from ``--repo_root`` and runs with that as the working
directory so the repo's ``config/...`` relative paths resolve.

Mirrors antgroup/echomimic_v3 `infer_preview.py` (verified 2026-06):
  https://github.com/antgroup/echomimic_v3/blob/main/infer_preview.py

Run via models.py (premium tier). Unknown CLI flags are ignored so the same
argument vector used for ``infer_flash.py`` is accepted here too.
"""

from __future__ import annotations

import argparse
import math
import os
import sys


def _get_mask_coord(image_path: str):
    """Face bounding box for the IP-mask.

    Upstream uses retinaface -> tensorflow.keras, which the echomimic venv's
    ml_dtypes upgrade breaks (``No module named 'tensorflow.keras'``). insightface
    (onnxruntime, already on the volume as buffalo_l) gives the same bbox with no
    tensorflow dependency. Returns (y1, y2, x1, x2, height, width) to match the
    original ``src.face_detect.get_mask_coord`` contract.
    """
    import numpy as np
    from PIL import Image
    from insightface.app import FaceAnalysis

    img = np.array(Image.open(image_path).convert("RGB"))[:, :, ::-1]  # RGB -> BGR
    height, width, _ = img.shape

    root = os.environ.get("INSIGHTFACE_HOME") or os.path.expanduser("~/.insightface")
    # Detection only, on CPU: a single still doesn't need the GPU and this avoids
    # contending with the EchoMimicV3 transformer already resident in VRAM.
    detector = FaceAnalysis(
        name="buffalo_l",
        root=root,
        allowed_modules=["detection"],
        providers=["CPUExecutionProvider"],
    )
    detector.prepare(ctx_id=-1, det_size=(640, 640))

    # Avatar keyframes are tight face crops; SCRFD often misses a face that fills
    # the whole frame, so retry on a border-padded copy and map coords back.
    faces = detector.get(img)
    if faces:
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        x1, y1, x2, y2 = face.bbox.astype(int)
        return int(y1), int(y2), int(x1), int(x2), height, width

    import cv2

    pad = int(0.4 * max(height, width))
    padded = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    faces = detector.get(padded)
    if faces:
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        x1, y1, x2, y2 = face.bbox.astype(int)
        x1 = max(0, min(width, x1 - pad)); x2 = max(0, min(width, x2 - pad))
        y1 = max(0, min(height, y1 - pad)); y2 = max(0, min(height, y2 - pad))
        if x2 > x1 and y2 > y1:
            return int(y1), int(y2), int(x1), int(x2), height, width

    # The keyframe is already a face crop: fall back to the full frame so the
    # IP-mask covers the whole image rather than failing the render.
    print(f"[echomimic] no face detected in {image_path}; using full-frame IP-mask", flush=True)
    return 0, height, 0, width, height, width


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="EchoMimicV3-preview single-input inference")
    p.add_argument("--repo_root", type=str, required=True)
    p.add_argument("--image_path", type=str, required=True)
    p.add_argument("--audio_path", type=str, required=True)
    p.add_argument("--prompt", type=str, required=True)
    p.add_argument("--save_path", type=str, default="outputs")

    p.add_argument("--config_path", type=str, default="config/config.yaml")
    p.add_argument("--model_name", type=str, default="models/Wan2.1-Fun-V1.1-1.3B-InP")
    p.add_argument("--transformer_path", type=str, default="models/transformer/diffusion_pytorch_model.safetensors")
    p.add_argument("--vae_path", type=str, default=None)
    p.add_argument("--wav2vec_model_dir", type=str, default="models/wav2vec2-base-960h")

    p.add_argument("--sampler_name", type=str, default="Flow_DPM++", choices=["Flow", "Flow_Unipc", "Flow_DPM++"])
    p.add_argument("--num_inference_steps", type=int, default=20)
    p.add_argument("--guidance_scale", type=float, default=4.5)
    p.add_argument("--audio_guidance_scale", type=float, default=2.5)
    p.add_argument("--audio_scale", type=float, default=1.0)
    p.add_argument("--neg_scale", type=float, default=1.5)
    p.add_argument("--neg_steps", type=int, default=2)
    p.add_argument("--shift", type=float, default=5.0)
    p.add_argument("--seed", type=int, default=43)

    p.add_argument("--video_length", type=int, default=0, help="0 = full audio length")
    p.add_argument("--partial_video_length", type=int, default=113)
    p.add_argument("--overlap_video_length", type=int, default=8)
    p.add_argument("--sample_size", type=int, nargs=2, default=[768, 768])
    p.add_argument("--fps", type=int, default=25)
    p.add_argument("--weight_dtype", type=str, default="bfloat16", choices=["float16", "bfloat16"])
    p.add_argument("--GPU_memory_mode", type=str, default="sequential_cpu_offload")

    p.add_argument("--num_skip_start_steps", type=int, default=5)
    p.add_argument("--enable_teacache", action="store_true", default=False)
    p.add_argument("--teacache_threshold", type=float, default=0.1)
    p.add_argument("--teacache_offload", action="store_true", default=False)
    p.add_argument("--use_dynamic_cfg", action="store_true", default=False)
    p.add_argument("--use_dynamic_acfg", action="store_true", default=False)
    p.add_argument("--enable_riflex", action="store_true", default=False)
    p.add_argument("--riflex_k", type=int, default=6)
    p.add_argument("--use_un_ip_mask", action="store_true", default=False)
    p.add_argument("--cfg_skip_ratio", type=float, default=0.0)
    p.add_argument("--ulysses_degree", type=int, default=1)
    p.add_argument("--ring_degree", type=int, default=1)
    p.add_argument(
        "--negative_prompt",
        type=str,
        default=(
            "Gesture is bad. Gesture is unclear. Strange and twisted hands. Bad hands. "
            "Bad fingers. Unclear and blurry hands."
        ),
    )
    # Accept (and ignore) any flash-only flags so one argument vector serves both.
    args, _ = p.parse_known_args()
    return args


def main() -> None:
    args = parse_args()

    repo_root = os.path.abspath(args.repo_root)
    sys.path.insert(0, repo_root)
    os.chdir(repo_root)

    import datetime

    import librosa
    import numpy as np
    import torch
    from PIL import Image
    from omegaconf import OmegaConf
    from transformers import AutoTokenizer, Wav2Vec2Model, Wav2Vec2Processor
    from moviepy import VideoFileClip, AudioFileClip
    from diffusers import FlowMatchEulerDiscreteScheduler

    from src.dist import set_multi_gpus_devices
    from src.wan_vae import AutoencoderKLWan
    from src.wan_image_encoder import CLIPModel
    from src.wan_text_encoder import WanT5EncoderModel
    from src.wan_transformer3d_audio import WanTransformerAudioMask3DModel
    from src.pipeline_wan_fun_inpaint_audio import WanFunInpaintAudioPipeline
    from src.utils import filter_kwargs, get_image_to_video_latent3, save_videos_grid
    from src.fm_solvers import FlowDPMSolverMultistepScheduler
    from src.fm_solvers_unipc import FlowUniPCMultistepScheduler
    from src.cache_utils import get_teacache_coefficients

    weight_dtype = torch.bfloat16 if args.weight_dtype == "bfloat16" else torch.float16
    device = set_multi_gpus_devices(args.ulysses_degree, args.ring_degree)
    cfg = OmegaConf.load(args.config_path)

    transformer = WanTransformerAudioMask3DModel.from_pretrained(
        os.path.join(args.model_name, cfg["transformer_additional_kwargs"].get("transformer_subpath", "transformer")),
        transformer_additional_kwargs=OmegaConf.to_container(cfg["transformer_additional_kwargs"]),
        torch_dtype=weight_dtype,
    )
    if args.transformer_path:
        if args.transformer_path.endswith("safetensors"):
            from safetensors.torch import load_file

            state_dict = load_file(args.transformer_path)
        else:
            state_dict = torch.load(args.transformer_path)
            state_dict = state_dict.get("state_dict", state_dict)
        missing, unexpected = transformer.load_state_dict(state_dict, strict=False)
        print(f"Missing keys: {len(missing)}, Unexpected keys: {len(unexpected)}")

    vae = AutoencoderKLWan.from_pretrained(
        os.path.join(args.model_name, cfg["vae_kwargs"].get("vae_subpath", "vae")),
        additional_kwargs=OmegaConf.to_container(cfg["vae_kwargs"]),
    ).to(weight_dtype)

    tokenizer = AutoTokenizer.from_pretrained(
        os.path.join(args.model_name, cfg["text_encoder_kwargs"].get("tokenizer_subpath", "tokenizer")),
    )
    text_encoder = WanT5EncoderModel.from_pretrained(
        os.path.join(args.model_name, cfg["text_encoder_kwargs"].get("text_encoder_subpath", "text_encoder")),
        additional_kwargs=OmegaConf.to_container(cfg["text_encoder_kwargs"]),
        torch_dtype=weight_dtype,
    ).eval()
    clip_image_encoder = CLIPModel.from_pretrained(
        os.path.join(args.model_name, cfg["image_encoder_kwargs"].get("image_encoder_subpath", "image_encoder")),
    ).to(weight_dtype).eval()

    scheduler_cls = {
        "Flow": FlowMatchEulerDiscreteScheduler,
        "Flow_Unipc": FlowUniPCMultistepScheduler,
        "Flow_DPM++": FlowDPMSolverMultistepScheduler,
    }[args.sampler_name]
    scheduler = scheduler_cls(**filter_kwargs(scheduler_cls, OmegaConf.to_container(cfg["scheduler_kwargs"])))

    pipeline = WanFunInpaintAudioPipeline(
        transformer=transformer,
        vae=vae,
        tokenizer=tokenizer,
        text_encoder=text_encoder,
        scheduler=scheduler,
        clip_image_encoder=clip_image_encoder,
    )
    pipeline.to(device=device)

    if args.enable_teacache:
        coefficients = get_teacache_coefficients(args.model_name)
        pipeline.transformer.enable_teacache(
            coefficients, args.num_inference_steps, args.teacache_threshold,
            num_skip_start_steps=args.num_skip_start_steps, offload=args.teacache_offload,
        )

    wav2vec_processor = Wav2Vec2Processor.from_pretrained(args.wav2vec_model_dir)
    wav2vec_model = Wav2Vec2Model.from_pretrained(args.wav2vec_model_dir).eval()
    wav2vec_model.requires_grad_(False)

    os.makedirs(args.save_path, exist_ok=True)
    generator = torch.Generator(device=device).manual_seed(args.seed)

    ref_img = Image.open(args.image_path).convert("RGB")

    audio_clip = AudioFileClip(args.audio_path)
    audio_segment, _ = librosa.load(args.audio_path, sr=16000)
    input_values = wav2vec_processor(audio_segment, sampling_rate=16000, return_tensors="pt").input_values
    audio_features = wav2vec_model(input_values).last_hidden_state.squeeze(0)
    audio_embeds = audio_features.unsqueeze(0).to(device=device, dtype=weight_dtype)

    video_length = int(audio_clip.duration * args.fps) if args.video_length <= 0 else args.video_length
    tcr = vae.config.temporal_compression_ratio
    video_length = (int((video_length - 1) // tcr * tcr) + 1) if video_length != 1 else 1

    y1, y2, x1, x2, h_, w_ = _get_mask_coord(args.image_path)

    def _sample_size(image, default):
        width, height = image.size
        original_area = width * height
        default_area = default[0] * default[1]
        if default_area < original_area:
            ratio = math.sqrt(original_area / default_area)
            width = width / ratio // 16 * 16
            height = height / ratio // 16 * 16
        else:
            width = width // 16 * 16
            height = height // 16 * 16
        return int(height), int(width)

    def _ip_mask(coords):
        cy1, cy2, cx1, cx2, ch, cw = coords
        Y, X = torch.meshgrid(torch.arange(ch), torch.arange(cw), indexing="ij")
        mask = (Y.unsqueeze(-1) >= cy1) & (Y.unsqueeze(-1) < cy2) & (X.unsqueeze(-1) >= cx1) & (X.unsqueeze(-1) < cx2)
        return mask.reshape(-1).float()

    sample_height, sample_width = _sample_size(ref_img, args.sample_size)
    downratio = math.sqrt(sample_height * sample_width / h_ / w_)
    coords = (
        y1 * downratio // 16, y2 * downratio // 16,
        x1 * downratio // 16, x2 * downratio // 16,
        sample_height // 16, sample_width // 16,
    )
    ip_mask = _ip_mask(coords).unsqueeze(0)
    ip_mask = torch.cat([ip_mask] * 3).to(device=device, dtype=weight_dtype)

    partial_video_length = (
        int((args.partial_video_length - 1) // tcr * tcr) + 1 if video_length != 1 else 1
    )
    latent_frames = (partial_video_length - 1) // tcr + 1

    # EchoMimic's audio cross-attention breaks on a small final partial window
    # (e.g. a 25-frame tail -> "tensor a (21) must match tensor b (18)"). Clamp
    # video_length down to a clean tiling so every window is a full
    # partial_video_length; the dropped tail is at most one stride (<~4s).
    _stride = partial_video_length - args.overlap_video_length
    if _stride > 0 and video_length > partial_video_length:
        _n = (video_length - partial_video_length) // _stride
        video_length = partial_video_length + _n * _stride
    elif 1 < video_length < partial_video_length:
        video_length = partial_video_length
    if args.enable_riflex:
        pipeline.transformer.enable_riflex(k=args.riflex_k, L_test=latent_frames)

    init_frames = 0
    last_frames = init_frames + partial_video_length
    new_sample = None
    mix_ratio = torch.linspace(0, 1, steps=args.overlap_video_length).view(1, 1, -1, 1, 1)

    while init_frames < video_length:
        if last_frames >= video_length:
            partial_video_length = video_length - init_frames
            partial_video_length = (
                int((partial_video_length - 1) // tcr * tcr) + 1 if video_length != 1 else 1
            )
        if partial_video_length <= 0:
            break

        input_video, input_video_mask, clip_image = get_image_to_video_latent3(
            ref_img, None, video_length=partial_video_length, sample_size=[sample_height, sample_width]
        )
        partial_audio_embeds = audio_embeds[:, init_frames * 2 : (init_frames + partial_video_length) * 2]

        sample = pipeline(
            args.prompt,
            num_frames=partial_video_length,
            negative_prompt=args.negative_prompt,
            audio_embeds=partial_audio_embeds,
            audio_scale=args.audio_scale,
            ip_mask=ip_mask,
            use_un_ip_mask=args.use_un_ip_mask,
            height=sample_height,
            width=sample_width,
            generator=generator,
            neg_scale=args.neg_scale,
            neg_steps=args.neg_steps,
            use_dynamic_cfg=args.use_dynamic_cfg,
            use_dynamic_acfg=args.use_dynamic_acfg,
            guidance_scale=args.guidance_scale,
            audio_guidance_scale=args.audio_guidance_scale,
            num_inference_steps=args.num_inference_steps,
            video=input_video,
            mask_video=input_video_mask,
            clip_image=clip_image,
            cfg_skip_ratio=args.cfg_skip_ratio,
            shift=args.shift,
            use_longvideo_cfg=False,
            overlap_video_length=args.overlap_video_length,
            partial_video_length=partial_video_length,
        ).videos

        if init_frames != 0:
            new_sample[:, :, -args.overlap_video_length:] = (
                new_sample[:, :, -args.overlap_video_length:] * (1 - mix_ratio)
                + sample[:, :, : args.overlap_video_length] * mix_ratio
            )
            new_sample = torch.cat([new_sample, sample[:, :, args.overlap_video_length:]], dim=2)
            sample = new_sample
        else:
            new_sample = sample

        if last_frames >= video_length:
            break

        ref_img = [
            Image.fromarray(
                (sample[0, :, i].transpose(0, 1).transpose(1, 2) * 255).numpy().astype(np.uint8)
            )
            for i in range(-args.overlap_video_length, 0)
        ]
        init_frames += partial_video_length - args.overlap_video_length
        last_frames = init_frames + partial_video_length

    stem = os.path.basename(args.image_path).split(".")[0]
    stamp = datetime.datetime.now().strftime("%H%M%S")
    tmp_path = os.path.join(args.save_path, f"{stem}_{stamp}_tmp.mp4")
    out_path = os.path.join(args.save_path, f"{stem}_audio.mp4")
    save_videos_grid(sample[:, :, :video_length], tmp_path, fps=args.fps)

    video_clip = VideoFileClip(tmp_path)
    audio_clip = audio_clip.subclipped(0, min(video_length / args.fps, audio_clip.duration))
    video_clip = video_clip.with_audio(audio_clip)
    video_clip.write_videofile(out_path, codec="libx264", audio_codec="aac", threads=2)
    os.remove(tmp_path)
    print(f"Saved output to: {out_path}")


if __name__ == "__main__":
    main()
