"""Explicit paid evaluation through the running app, with a resumable local report."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")
from backend.ai_evaluator import policy_signature
from backend.dataset import unpack_dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=ROOT / os.getenv("DATASET_FILE", "data/dev_dataset.json"))
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--ids", nargs="+")
    parser.add_argument("--force", action="store_true", help="Re-evaluate even current cached results")
    parser.add_argument("--report", type=Path, default=ROOT / "output/evaluation_run.json")
    args = parser.parse_args()
    group, records = unpack_dataset(json.loads(args.dataset.read_text(encoding="utf-8-sig")))
    ids = args.ids or [r["conversation_id"] for r in records]
    if len(ids) != len(set(ids)) or set(ids) - {r["conversation_id"] for r in records}:
        parser.error("IDs must be unique and belong to the supplied dataset")
    headers = {"X-Role": "supervisor", "X-Supervisor-Token": os.getenv("QA_SUPERVISOR_TOKEN", "")}
    checklist = requests.get(f"{args.base}/api/checklist", timeout=15)
    checklist.raise_for_status()
    report = {"group": group, "started_at": datetime.now(timezone.utc).isoformat(),
              "policy_signature": policy_signature(), "checklist": checklist.json(), "results": []}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    for position, cid in enumerate(ids, 1):
        started = time.monotonic()
        try:
            response = requests.post(f"{args.base}/api/evaluate/{cid}",
                                     params={"force": str(args.force).lower()}, headers=headers, timeout=110)
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            response = None
            data = {"detail": f"Transport failure: {type(exc).__name__}"}
        row = {"conversation_id": cid, "http": response.status_code if response is not None else 0,
               "elapsed_seconds": round(time.monotonic() - started, 2), **data}
        evaluation = data.get("evaluation")
        if evaluation and evaluation.get("policy_signature") != report["policy_signature"]:
            raise RuntimeError("Server instructions differ from local code; restart the server")
        report["results"].append(row)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"position": position, "total": len(ids), "id": cid, "http": row["http"],
                          "seconds": row["elapsed_seconds"], "cached": data.get("cached"),
                          "score": evaluation.get("final_score") if evaluation else None,
                          "error": data.get("detail")}, ensure_ascii=False), flush=True)
        if row["http"] in (0, 401, 403, 409, 503):
            break
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if len(report["results"]) == len(ids) and all(r["http"] == 200 for r in report["results"]) else 2


if __name__ == "__main__":
    raise SystemExit(main())
