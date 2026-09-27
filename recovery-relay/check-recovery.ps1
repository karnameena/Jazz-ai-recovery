param(
    [string]$RelayUrl = "http://127.0.0.1:8788",
    [string]$EnvFile = ".\services\recovery-relay\.env",
    [switch]$Location
)

$ErrorActionPreference = "Stop"

function Read-DotEnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path $Path)) { throw "Recovery .env not found: $Path" }
    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
    if (-not $line) { throw "$Name is missing from $Path" }
    $value = $line.Substring($line.IndexOf('=') + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is empty in $Path" }
    return $value
}

$ownerToken = Read-DotEnvValue $EnvFile "JAZZ_RECOVERY_OWNER_TOKEN"
$headers = @{ Authorization = "Bearer $ownerToken" }
$base = $RelayUrl.TrimEnd('/')

Write-Host "Jazz Recovery Relay check" -ForegroundColor Cyan
Write-Host "Relay: $base"

$health = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 10
Write-Host "Health: OK (version=$($health.version))" -ForegroundColor Green

$status = Invoke-RestMethod -Uri "$base/status" -Method Get -Headers $headers -TimeoutSec 10
Write-Host "Device online: $($status.online)" -ForegroundColor $(if ($status.online) { "Green" } else { "Yellow" })
Write-Host "Last seen: $($status.lastSeen)"
Write-Host "Mode: $($status.mode)"
Write-Host "Device ID: $($status.deviceId)"

if ($Location) {
    Write-Host "Requesting device location..." -ForegroundColor Cyan
    $result = Invoke-RestMethod -Uri "$base/location" -Method Get -Headers $headers -TimeoutSec 40
    $result | ConvertTo-Json -Depth 8
} else {
    $status | ConvertTo-Json -Depth 8
}
