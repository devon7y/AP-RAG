#!/usr/bin/env bash
set -euo pipefail

PC_HOST="${PC_HOST:-pc}"
PC_URL="${PC_URL:-http://100.98.84.84}"

ssh "$PC_HOST" 'powershell -NoProfile -ExecutionPolicy Bypass -Command -' <<'PS'
$ErrorActionPreference = "Continue"

function Test-Listener {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Http {
    param(
        [string]$Name,
        [string]$Url,
        [int]$TimeoutSeconds = 180
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $Url
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                Write-Host "$Name ready: $($response.Content.Substring(0, [Math]::Min(240, $response.Content.Length)))"
                return $true
            }
        } catch {
            Start-Sleep -Seconds 5
        }
    }
    Write-Host "$Name did not become ready within ${TimeoutSeconds}s"
    return $false
}

Write-Host "Stopping any hung WestburyQueryServer task..."
schtasks /End /TN WestburyQueryServer 2>$null | Out-Null

Write-Host "Checking Octen embedding server on :8000..."
if (-not (Test-Listener 8000)) {
    schtasks /Run /TN OctenEmbedServer | Out-Host
} else {
    Write-Host "Octen already has a listener on :8000"
}
Wait-Http "Octen" "http://127.0.0.1:8000/health" 300 | Out-Null

Write-Host "Checking Qdrant on :6333..."
if (-not (Test-Listener 6333)) {
    # Launch via Task Scheduler, NOT Start-Process: a process started directly
    # from this SSH session is killed by Windows OpenSSH when the session ends.
    # The scheduled task runs detached and survives the SSH disconnect.
    schtasks /Run /TN Qdrant | Out-Host
} else {
    Write-Host "Qdrant already has a listener on :6333"
}
Wait-Http "Qdrant" "http://127.0.0.1:6333/collections" 300 | Out-Null

Write-Host "Starting Westbury query server on :8001..."
schtasks /Run /TN WestburyQueryServer | Out-Host
Wait-Http "WestburyQueryServer" "http://127.0.0.1:8001/health" 300 | Out-Null

Write-Host ""
Write-Host "Listeners:"
Get-NetTCPConnection -LocalPort 8001,8000,6333 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,State,OwningProcess |
    Format-Table -AutoSize

Write-Host ""
Write-Host "Processes:"
Get-Process python,qdrant -ErrorAction SilentlyContinue |
    Select-Object Id,ProcessName,@{Name="MemMB";Expression={[math]::Round($_.WorkingSet64/1MB,1)}},CPU,StartTime |
    Format-Table -AutoSize
PS

echo
echo "Mac-side health check:"
curl --connect-timeout 5 --max-time 20 "$PC_URL:8001/health"
echo
