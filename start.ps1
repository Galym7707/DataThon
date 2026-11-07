param([int]$Port = 8000, [switch]$Setup)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create Python environment' }
    $Setup = $true
}
if ($Setup) {
    & $pythonPath -m pip install -r backend/requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
}
Write-Host "Freedom CQA: http://127.0.0.1:$Port (Ctrl+C to stop)"
& $pythonPath -m uvicorn backend.main:app --host 127.0.0.1 --port $Port --workers 1
