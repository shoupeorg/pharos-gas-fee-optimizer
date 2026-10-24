$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.dev.vars')) { throw 'Missing .dev.vars. Run node scripts/generate-demo-secrets.mjs once.' }
$text = Get-Content -LiteralPath '.dev.vars' -Raw
foreach ($name in @('DEMO_SIGNER_PRIVATE_KEY','DEMO_SIGNER_ADDRESS','OWNER_TOKEN')) { if ($text -notmatch "(?m)^$name=.+$") { throw "Missing secret $name" } }
npx wrangler secret bulk '.dev.vars'
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Cloudflare secrets.' }
Write-Host 'Cloudflare secrets configured without printing secret values.' -ForegroundColor Green
