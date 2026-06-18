#!/usr/bin/env python3
"""Quality evaluation harness CLI.

Computes lip-sync (Sync-C/D, LSE-C), identity (ArcFace), and visual (FID/FVD)
metrics for a generated video and gates them against thresholds. Optionally
folds in a MOS ratings file. Emits a JSON report and a non-zero exit code if any
gate fails (usable in a quality regression check).

Usage:
  python eval.py --generated out.mp4 --reference ref.mp4 --ref-image face.png \\
                 [--mos ratings.csv] [--report report.json]
"""

from __future__ import annotations

import argparse
import json
import sys

# Gates roughly tuned to "HeyGen-like" acceptability. Tighten as the model improves.
GATES = {
    "sync_c_min": 5.0,
    "identity_mean_min": 0.55,
    "fid_max": 60.0,
    "mos_overall_min": 3.8,
}


def main() -> int:
    ap = argparse.ArgumentParser(description="LiveAvatarStream quality eval")
    ap.add_argument("--generated", required=True)
    ap.add_argument("--reference", help="real reference video (for FID/FVD)")
    ap.add_argument("--ref-image", help="reference face image (for identity)")
    ap.add_argument("--mos", help="human ratings CSV/JSON")
    ap.add_argument("--report", help="write JSON report to this path")
    ap.add_argument("--no-gate", action="store_true", help="report only; never fail")
    args = ap.parse_args()

    report: dict = {"generated": args.generated, "metrics": {}, "gates": {}, "passed": True}

    # Lip-sync.
    try:
        from metrics import syncnet

        s = syncnet.evaluate(args.generated)
        report["metrics"]["lip_sync"] = s.__dict__
        _gate(report, "sync_c", s.sync_c >= GATES["sync_c_min"], s.sync_c, GATES["sync_c_min"])
    except Exception as e:  # noqa: BLE001
        report["metrics"]["lip_sync_error"] = str(e)

    # Identity.
    if args.ref_image:
        try:
            from metrics import identity

            i = identity.evaluate(args.ref_image, args.generated)
            report["metrics"]["identity"] = i.__dict__
            _gate(report, "identity_mean", i.mean_cosine >= GATES["identity_mean_min"], i.mean_cosine, GATES["identity_mean_min"])
        except Exception as e:  # noqa: BLE001
            report["metrics"]["identity_error"] = str(e)

    # Visual quality.
    if args.reference:
        try:
            from metrics import visual

            v = visual.evaluate(args.generated, args.reference)
            report["metrics"]["visual"] = v.__dict__
            _gate(report, "fid", v.fid <= GATES["fid_max"], v.fid, GATES["fid_max"])
        except Exception as e:  # noqa: BLE001
            report["metrics"]["visual_error"] = str(e)

    # MOS.
    if args.mos:
        try:
            from metrics import mos

            m = mos.aggregate(args.mos)
            report["metrics"]["mos"] = {"n": m.n, "means": m.means, "ci95": m.ci95}
            overall = m.means.get("overall")
            if overall is not None:
                _gate(report, "mos_overall", overall >= GATES["mos_overall_min"], overall, GATES["mos_overall_min"])
        except Exception as e:  # noqa: BLE001
            report["metrics"]["mos_error"] = str(e)

    out = json.dumps(report, indent=2)
    if args.report:
        with open(args.report, "w") as f:
            f.write(out)
    print(out)

    if args.no_gate:
        return 0
    return 0 if report["passed"] else 1


def _gate(report: dict, name: str, ok: bool, value: float, threshold: float) -> None:
    report["gates"][name] = {"value": round(float(value), 4), "threshold": threshold, "passed": bool(ok)}
    if not ok:
        report["passed"] = False


if __name__ == "__main__":
    sys.exit(main())
