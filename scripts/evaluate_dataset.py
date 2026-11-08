"""Interactive evaluation of an organizer dataset through the protected local API.

Every uncached/forced request requires review of its actual prepared content.
Only safe metadata is saved; no original transcript, preview or mapping is logged.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import quote, urlsplit

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")
from backend.evaluation_policy import EVALUATION_POLICY_VERSION
from backend.dataset import canonical_group, unpack_dataset
from scripts.live_smoke import SmokeError, prepare_and_confirm, read_response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=ROOT / os.getenv("DATASET_FILE", "data/dev_dataset.json"))
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--ids", nargs="+")
    parser.add_argument("--force", action="store_true", help="Re-evaluate current results after interactive confirmation")
    parser.add_argument("--report", type=Path, default=ROOT / "output/evaluation_run.json")
    args = parser.parse_args()
    location = urlsplit(args.base)
    if (location.scheme not in ("http", "https") or location.hostname not in ("127.0.0.1", "localhost", "::1")
            or location.username or location.password or location.query or location.fragment
            or location.path not in ("", "/")):
        parser.error("--base must be a local loopback URL without credentials, path, query or fragment")
    base = args.base.rstrip("/")
    group, records = unpack_dataset(json.loads(args.dataset.read_text(encoding="utf-8-sig")))
    if canonical_group(group) == "SWAP":
        parser.error("SWAP is stored for later instructions and must not be evaluated yet")
    ids = args.ids or [r["conversation_id"] for r in records]
    if len(ids) != len(set(ids)) or set(ids) - {r["conversation_id"] for r in records}:
        parser.error("IDs must be unique and belong to the supplied dataset")
    headers = {"X-Role": "supervisor", "X-Supervisor-Token": os.getenv("QA_SUPERVISOR_TOKEN", "")}
    report = {"group": group, "started_at": datetime.now(timezone.utc).isoformat(),
              "policy_version": EVALUATION_POLICY_VERSION, "results": []}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with requests.Session() as session:
        session.trust_env = False
        for position, cid in enumerate(ids, 1):
            started = time.monotonic()
            row = {"conversation_id": cid, "position": position}
            try:
                target = quote(cid, safe="")
                current = read_response(session.get(f"{base}/api/conversations/{target}", headers=headers,
                                                    timeout=15, allow_redirects=False), "read status")
                send_headers = dict(headers)
                if current.get("status") != "Evaluated" or args.force:
                    preview_id = prepare_and_confirm(session, base, cid, headers, force=args.force)
                    if preview_id is None:
                        raise SmokeError("Cancelled; no AI request sent")
                    send_headers["X-AI-Preview"] = preview_id
                response = session.post(f"{base}/api/evaluate/{target}", params={"force": str(args.force).lower()},
                                        headers=send_headers, timeout=110, allow_redirects=False)
                row["http"] = response.status_code
                data = read_response(response, "evaluate conversation")
                evaluation = data.get("evaluation")
                if not evaluation:
                    raise SmokeError("No completed assessment; manual review may be needed")
                if evaluation.get("policy_version") != EVALUATION_POLICY_VERSION:
                    raise SmokeError("Server policy differs from local code; restart the server")
                row.update(cached=data.get("cached"), score=evaluation["final_score"], usage=evaluation.get("usage", {}))
            except (requests.RequestException, ValueError, KeyError, TypeError, EOFError, KeyboardInterrupt) as exc:
                row["error"] = str(exc) if isinstance(exc, SmokeError) else f"{type(exc).__name__}; stopped without retry"
            except SmokeError as exc:
                row["error"] = str(exc)
            row["elapsed_seconds"] = round(time.monotonic() - started, 2)
            report["results"].append(row)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(row, ensure_ascii=False), flush=True)
            if row.get("error"):
                break
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if len(report["results"]) == len(ids) and all(not r.get("error") for r in report["results"]) else 2


if __name__ == "__main__":
    raise SystemExit(main())
