"""Import an organizer response into the ignored local dataset file."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from backend.main import unpack_dataset

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source",type=Path)
args = parser.parse_args()
payload = json.loads(args.source.read_text(encoding="utf-8-sig"))
group,records = unpack_dataset(payload)
destination=ROOT/"data"/"dev_dataset.json"
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")
print(f"Imported {len(records)} records, group {group}. Restart the app if its store is empty; otherwise use the dataset refresh endpoint.")
