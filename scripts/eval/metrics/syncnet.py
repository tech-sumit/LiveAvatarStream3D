"""Lip-sync metrics via SyncNet.

  Sync-C  (confidence): higher is better; >~6 is strong sync.
  Sync-D  (distance):   lower is better.
  LSE-C / LSE-D:        Lip-Sync Error variants used by Wav2Lip-era papers.

Wraps the vendored syncnet_python model. Loads lazily so importing the module
does not require model weights.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class SyncResult:
    sync_c: float
    sync_d: float
    lse_c: float
    lse_d: float


def evaluate(video_path: str) -> SyncResult:
    """Run SyncNet over a talking-head video (audio + face track)."""
    from _vendor.syncnet import SyncNetInstance  # type: ignore  # vendored

    weights = os.environ.get("SYNCNET_WEIGHTS", "metrics/_vendor/syncnet_v2.model")
    inst = SyncNetInstance()
    inst.loadParameters(weights)
    offset, conf, dists = inst.evaluate(videofile=video_path)
    sync_c = float(conf)
    sync_d = float(min(dists)) if len(dists) else float("nan")
    # LSE-C/LSE-D are the same confidence/distance reported as Lip-Sync Error.
    return SyncResult(sync_c=sync_c, sync_d=sync_d, lse_c=sync_c, lse_d=sync_d)
