$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.dev.vars')) { throw 'Missing .dev.vars. Run node scripts/generate-demo-secrets.mjs once.' }
$pairs = @{}
Get-Content -LiteralPath '.dev.vars' | ForEach-Object { if ($_ -match '^([^=]+)=(.+)$') { $pairs[$Matches[1]] = $Matches[2] } }
foreach ($name in @('DEMO_SIGNER_PRIVATE_KEY','DEMO_SIGNER_ADDRESS','OWNER_TOKEN')) {
  if (-not $pairs.ContainsKey($name)) { throw "Missing secret $name" }
  $pairs[$name] | npx wrangler secret put $name
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure $name" }
}
Write-Host 'Cloudflare secrets configured without printing secret values.' -ForegroundColor Green
