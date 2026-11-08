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
from backend.ai_evaluator import policy_signature
from backend.dataset import unpack_dataset
from backend.results_export import build_submission, validate_submission


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--team", required=True)
    parser.add_argument("--group", choices=("dev", "prod"), default="dev")
    parser.add_argument("--dataset", type=Path, default=ROOT / os.getenv("DATASET_FILE", "data/dev_dataset.json"))
    parser.add_argument("--store", type=Path, default=ROOT / os.getenv("DATA_STORE_PATH", "data/data_store.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    group, records = unpack_dataset(json.loads(args.dataset.read_text(encoding="utf-8-sig")))
    expected = 65 if args.group == "dev" else 10
    if len(records) != expected:
        parser.error(f"{args.group.upper()} requires {expected} records, got {len(records)}")
    if (group.upper() == "DEV") != (args.group == "dev"):
        parser.error("Dataset group does not match the destination dev/prod folder")
    store = json.loads(args.store.read_text(encoding="utf-8"))
    submission = build_submission(records, store["checklist"], store["evaluations"], args.team,
                                  policy_signature(), os.getenv("OPENAI_MODEL", "gpt-4o"))
    schema = json.loads((ROOT / "results/schema.json").read_text(encoding="utf-8"))
    validate_submission(submission, records, schema)
    destination = args.output or ROOT / "results" / args.group / "results.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(submission, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    errors = sum(r["status"] == "error" for r in submission["results"])
    print(json.dumps({"file": str(destination), "records": len(records), "ok": len(records)-errors,
                      "errors": errors, "model": submission["model"]}, ensure_ascii=False))
    return 2 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
