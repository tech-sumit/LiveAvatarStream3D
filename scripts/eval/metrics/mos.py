"""Mean Opinion Score aggregation.

Reads a ratings file (CSV or JSON) of human 1-5 scores across dimensions
(naturalness, lip_sync, identity, overall) and aggregates mean + 95% CI.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass, field


DIMENSIONS = ["naturalness", "lip_sync", "identity", "overall"]


@dataclass
class MosResult:
    n: int
    means: dict = field(default_factory=dict)
    ci95: dict = field(default_factory=dict)


def _read(path: str) -> list[dict]:
    if path.endswith(".json"):
        with open(path) as f:
            return json.load(f)
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def aggregate(ratings_path: str) -> MosResult:
    rows = _read(ratings_path)
    res = MosResult(n=len(rows))
    for dim in DIMENSIONS:
        vals = [float(r[dim]) for r in rows if r.get(dim) not in (None, "")]
        if not vals:
            continue
        mean = sum(vals) / len(vals)
        if len(vals) > 1:
            var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
            ci = 1.96 * math.sqrt(var / len(vals))
        else:
            ci = 0.0
        res.means[dim] = round(mean, 3)
        res.ci95[dim] = round(ci, 3)
    return res
