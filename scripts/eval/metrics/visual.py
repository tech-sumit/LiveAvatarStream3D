"""Visual quality: FID (per-frame) and FVD (video).

FID compares the distribution of generated frames to real reference frames via
InceptionV3 features. FVD does the same with an I3D video feature extractor.
Lower is better for both. I3D weights are vendored under _vendor.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class VisualResult:
    fid: float
    fvd: float


def _frechet_distance(mu1, sigma1, mu2, sigma2) -> float:
    import numpy as np
    from scipy import linalg

    diff = mu1 - mu2
    covmean, _ = linalg.sqrtm(sigma1.dot(sigma2), disp=False)
    if np.iscomplexobj(covmean):
        covmean = covmean.real
    return float(diff.dot(diff) + np.trace(sigma1 + sigma2 - 2.0 * covmean))


def _stats(feats):
    import numpy as np

    return np.mean(feats, axis=0), np.cov(feats, rowvar=False)


def _inception_features(frames):
    import torch
    from torchvision.models import inception_v3, Inception_V3_Weights

    model = inception_v3(weights=Inception_V3_Weights.DEFAULT, transform_input=False).eval().to("cuda")
    model.fc = torch.nn.Identity()
    with torch.no_grad():
        return model(frames.to("cuda")).cpu().numpy()


def _load_frames(video_path, size=299, max_frames=300):
    import cv2
    import numpy as np
    import torch

    cap = cv2.VideoCapture(video_path)
    out = []
    while len(out) < max_frames:
        ok, f = cap.read()
        if not ok:
            break
        f = cv2.cvtColor(cv2.resize(f, (size, size)), cv2.COLOR_BGR2RGB).astype("float32") / 255.0
        out.append(f)
    cap.release()
    arr = np.stack(out).transpose(0, 3, 1, 2)
    return torch.from_numpy(arr)


def evaluate(generated_video: str, reference_video: str) -> VisualResult:
    gen = _inception_features(_load_frames(generated_video))
    ref = _inception_features(_load_frames(reference_video))
    fid = _frechet_distance(*_stats(gen), *_stats(ref))

    # FVD via vendored I3D; optional (returns NaN if extractor missing).
    try:
        from _vendor.fvd import i3d_features, fvd_from_features  # type: ignore

        fvd = float(fvd_from_features(i3d_features(generated_video), i3d_features(reference_video)))
    except Exception:
        fvd = float("nan")
    return VisualResult(fid=float(fid), fvd=fvd)
