"""Explicit paid smoke test against a running local API; at most three IDs."""
import argparse
import json
import os
from pathlib import Path
import requests

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("ids",nargs="+",help="1 to 3 conversation IDs")
parser.add_argument("--base",default="http://127.0.0.1:8000")
args=parser.parse_args()
if not 1 <= len(args.ids) <= 3:
    parser.error("Choose at most three conversations")
headers={"X-Role":"supervisor","X-Supervisor-Token":os.getenv("QA_SUPERVISOR_TOKEN","")}
report=[]
for cid in args.ids:
    response=requests.post(f"{args.base}/api/evaluate/{cid}",headers=headers,timeout=100)
    data=response.json()
    entry={"id":cid,"http":response.status_code}
    if response.ok:
        e=data["evaluation"]
        entry.update(score=e["final_score"],criteria=len(e["criteria"]),cached=data["cached"],usage=e["usage"])
    else:
        entry["error"]=data.get("detail")
    report.append(entry)
    print(json.dumps(entry,ensure_ascii=True),flush=True)
    if not response.ok:
        break
output=Path(__file__).resolve().parent.parent/"output"/"validation.json"
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
