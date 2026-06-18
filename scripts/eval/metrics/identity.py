"""Identity preservation: ArcFace cosine similarity between the reference avatar
and the generated video's faces. 1.0 = identical; >~0.6 is good preservation.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass
class IdentityResult:
    mean_cosine: float
    min_cosine: float
    frames_scored: int


@lru_cache(maxsize=1)
def _analyzer():
    from insightface.app import FaceAnalysis  # lazy

    app = FaceAnalysis(name="buffalo_l")
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def _embed(img):
    faces = _analyzer().get(img)
    if not faces:
        return None
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])).normed_embedding


def evaluate(reference_image: str, video_path: str, sample_fps: float = 1.0) -> IdentityResult:
    import cv2
    import numpy as np

    ref = _embed(cv2.imread(reference_image))
    if ref is None:
        raise ValueError("no face in reference image")

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, int(round(fps / sample_fps)))

    sims: list[float] = []
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            emb = _embed(frame)
            if emb is not None:
                sims.append(float(np.dot(ref, emb)))
        idx += 1
    cap.release()

    if not sims:
        return IdentityResult(mean_cosine=0.0, min_cosine=0.0, frames_scored=0)
    return IdentityResult(
        mean_cosine=float(sum(sims) / len(sims)),
        min_cosine=float(min(sims)),
        frames_scored=len(sims),
    )
