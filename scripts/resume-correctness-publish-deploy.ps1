$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Project
$Safe = (Get-Location).Path

git -c "safe.directory=$Safe" push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'GitHub publication failed.' }

npm run deploy
if ($LASTEXITCODE -ne 0) { throw 'Cloudflare deployment failed.' }

node "$PSScriptRoot\verify-public.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Public verification failed.' }

$Local = (git -c "safe.directory=$Safe" rev-parse HEAD).Trim()
git -c "safe.directory=$Safe" fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Remote verification fetch failed.' }
$Remote = (git -c "safe.directory=$Safe" rev-parse origin/main).Trim()
if ($Local -ne $Remote) { throw "Commit mismatch: local=$Local remote=$Remote" }
Write-Host "CORRECTION PUBLICATION VERIFIED: $Remote" -ForegroundColor Green
