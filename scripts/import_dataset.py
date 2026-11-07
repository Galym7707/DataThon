"""Import an organizer response into the ignored local dataset file."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from backend.dataset import unpack_dataset

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source",type=Path)
parser.add_argument("--destination",type=Path,default=ROOT/"data"/"dev_dataset.json")
args = parser.parse_args()
payload = json.loads(args.source.read_text(encoding="utf-8-sig"))
group,records = unpack_dataset(payload)
destination=args.destination.resolve()
destination.parent.mkdir(parents=True,exist_ok=True)
destination.write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")
print(f"Imported {len(records)} records, group {group}. Restart the app if its store is empty; otherwise use the dataset refresh endpoint.")
