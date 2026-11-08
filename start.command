#!/bin/zsh
set -eu
cd "${0:A:h}"
if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
  open http://127.0.0.1:8000
  exit 0
fi
(sleep 2; open http://127.0.0.1:8000) &
exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
