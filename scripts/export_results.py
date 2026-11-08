"""Export the original DEV/PROD dataset to the organizer's JSON 1.0 format."""
import argparse
import json
import os
from pathlib import Path
import sys

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")
from backend.evaluation_policy import EVALUATION_POLICY_VERSION
from backend.dataset import canonical_group, record_group, unpack_dataset
from backend.results_export import build_submission, validate_submission


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--team", required=True)
    parser.add_argument("--group", choices=("dev", "prod"), default="dev")
    parser.add_argument("--dataset", type=Path, help="Optional original organizer response; otherwise select the group from the store")
    parser.add_argument("--store", type=Path, default=ROOT / os.getenv("DATA_STORE_PATH", "data/data_store.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    store = json.loads(args.store.read_text(encoding="utf-8"))
    target = "DEV" if args.group == "dev" else "FBroker"
    if args.dataset:
        group, records = unpack_dataset(json.loads(args.dataset.read_text(encoding="utf-8-sig")))
    else:
        group = target
        records = [r for cid, r in store["records"].items() if record_group(store, cid) == target]
    expected = 65 if args.group == "dev" else 10
    if len(records) != expected:
        parser.error(f"{args.group.upper()} requires {expected} records, got {len(records)}")
    if canonical_group(group) != target:
        parser.error("Dataset group does not match the destination dev/prod folder")
    submission = build_submission(records, store["checklist"], store["evaluations"], args.team,
                                  EVALUATION_POLICY_VERSION, os.getenv("OPENAI_MODEL", "gpt-4o"),
                                  store.get("evaluation_errors"))
    schema = json.loads((ROOT / "results/schema.json").read_text(encoding="utf-8"))
    validate_submission(submission, records, schema, store["checklist"]["criteria"])
    destination = args.output or ROOT / "results" / args.group / "results.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(submission, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    errors = sum(r["status"] == "error" for r in submission["results"])
    print(json.dumps({"file": str(destination), "records": len(records), "ok": len(records)-errors,
                      "errors": errors, "model": submission["model"]}, ensure_ascii=False))
    return 2 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
