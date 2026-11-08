"""Explicit, interactive paid smoke test against the local API; at most three IDs.

Uncached requests are prepared on the server, shown in full, and sent only after
an exact interactive confirmation. This script never disables privacy or limits.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import quote, urlsplit

import requests


class SmokeError(RuntimeError):
    """A content-free operational error safe for the summary report."""


def read_response(response, operation):
    if not response.ok or response.is_redirect:
        # Do not dump validation bodies, request content or provider error bodies.
        try:
            detail = response.json().get("detail")
            if isinstance(detail, str):
                print(detail[:500], file=sys.stderr)
        except (ValueError, AttributeError):
            pass
        raise SmokeError(f"HTTP {response.status_code}: {operation}")
    try:
        data = response.json()
    except ValueError:
        raise SmokeError(f"Invalid JSON: {operation}") from None
    if not isinstance(data, dict):
        raise SmokeError(f"Invalid response: {operation}")
    return data


def prepare_and_confirm(session, base, cid, headers, force=False):
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SmokeError("Uncached AI requests require an interactive terminal and preview confirmation")
    redactions = []
    while True:
        preview = read_response(session.post(
            f"{base}/api/ai/prepare", headers=headers,
            json={"purpose": "evaluation", "conversation_id": cid, "force": force, "redactions": redactions},
            timeout=30, allow_redirects=False), "prepare preview")
        preview_id, prepared = preview.get("preview_id"), preview.get("requests")
        if not isinstance(preview_id, str) or not isinstance(prepared, list):
            raise SmokeError("Invalid preview response; nothing sent")
        if preview.get("cached") is True and not prepared:
            return preview_id
        if (len(prepared) != 1 or not isinstance(prepared[0], dict)
                or prepared[0].get("purpose") != "evaluation" or prepared[0].get("target") != cid):
            raise SmokeError("Unexpected preview target; nothing sent")
        print(f"\nWhat external AI will receive for {cid} (local review, not saved to the report):")
        print(json.dumps(prepared[0], ensure_ascii=False, indent=2), flush=True)
        print(f"Preview expires at {preview.get('expires_at', 'unknown')}; every edit creates a new preview.")
        print(f"Type SEND {cid} to submit this exact request, HIDE to mask another value, or press Enter to cancel.")
        choice = input("> ").strip()
        if choice == f"SEND {cid}":
            return preview_id
        if choice != "HIDE":
            return None
        if len(redactions) >= 40:
            print("Maximum 40 additional values. Nothing has been sent.")
            continue
        value = getpass.getpass("Exact value to hide (input not echoed): ").strip()
        if not 1 <= len(value) <= 200:
            print("Enter a value from 1 to 200 characters. Nothing has been sent.")
            continue
        if value not in redactions:
            redactions.append(value)
        # The next iteration prepares and displays the changed request. The
        # previous confirmation/ticket is never reused for the changed content.


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ids", nargs="+", help="1 to 3 conversation IDs; each uncached send requires confirmation")
    parser.add_argument("--base", default="http://127.0.0.1:8000", help="Local API URL; defaults to http://127.0.0.1:8000")
    args = parser.parse_args(argv)
    if not 1 <= len(args.ids) <= 3 or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", cid) for cid in args.ids):
        parser.error("Choose 1 to 3 valid conversation IDs")
    location = urlsplit(args.base)
    if (location.scheme not in ("http", "https") or location.hostname not in ("127.0.0.1", "localhost", "::1")
            or location.username or location.password or location.query or location.fragment or location.path not in ("", "/")):
        parser.error("--base must be a local loopback URL without credentials, path, query or fragment")
    base = args.base.rstrip("/")
    headers = {"X-Role": "supervisor", "X-Supervisor-Token": os.getenv("QA_SUPERVISOR_TOKEN", "")}
    report = []
    exit_status = 0
    with requests.Session() as session:
        session.trust_env = False  # Local API requests must not pass through a proxy.
        for cid in args.ids:
            entry = {"id": cid}
            try:
                record = read_response(session.get(f"{base}/api/conversations/{quote(cid, safe='')}",
                                                   headers=headers, timeout=15, allow_redirects=False), "read conversation status")
                send_headers = dict(headers)
                if record.get("status") != "Evaluated":
                    preview_id = prepare_and_confirm(session, base, cid, headers)
                    if preview_id is None:
                        entry["cancelled"] = True
                        print("Cancelled. No AI request sent for this conversation.")
                        report.append(entry)
                        break
                    send_headers["X-AI-Preview"] = preview_id
                # Current cached results need no external request. If they become
                # stale meanwhile, the server requires a preview and rejects this
                # call; the script never retries or auto-confirms a new preview.
                response = session.post(f"{base}/api/evaluate/{quote(cid, safe='')}", headers=send_headers,
                                        timeout=100, allow_redirects=False)
                entry["http"] = response.status_code
                data = read_response(response, "evaluate conversation")
                if data.get("status") == "Review":
                    entry.update(status="Review", manual_review_code=data["manual_review"]["code"])
                else:
                    evaluation = data["evaluation"]
                    entry.update(score=evaluation["final_score"], criteria=len(evaluation["criteria"]),
                                 cached=data["cached"], usage=evaluation.get("usage", {}))
            except (EOFError, KeyboardInterrupt):
                entry["cancelled"] = True
                exit_status = 130
            except requests.RequestException as exc:
                entry["error"] = f"{type(exc).__name__}: no automatic retry"
                exit_status = 1
            except (SmokeError, KeyError, TypeError) as exc:
                entry["error"] = str(exc) if isinstance(exc, SmokeError) else "Invalid API response; stopped without retry"
                exit_status = 1
            report.append(entry)
            print(json.dumps(entry, ensure_ascii=True), flush=True)
            if entry.get("error") or entry.get("cancelled"):
                break
    output = Path(__file__).resolve().parent.parent / "output" / "validation.json"
    output.parent.mkdir(exist_ok=True)
    # Only result metadata is persisted: no preview, source text or redaction map.
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return exit_status


if __name__ == "__main__":
    raise SystemExit(main())
