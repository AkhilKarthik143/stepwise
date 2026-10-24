# Generate a self-signed TLS cert for local HTTPS on Windows (PowerShell).
# Requires OpenSSL on PATH (Git for Windows ships it at
# C:\Program Files\Git\usr\bin\openssl.exe).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\make_cert.ps1 [-LanIp 192.168.1.42]
#
# Tip: for a cert your headset trusts without a warning, use mkcert instead:
#   https://github.com/FiloSottile/mkcert

param(
  [string]$LanIp = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $root "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

# Auto-detect this machine's LAN IPv4 (the interface with a default gateway) so
# the cert covers the address the iPad/headset will actually hit. Override with
# -LanIp if detection picks the wrong adapter (VPN/virtual NICs).
if ($LanIp -eq "") {
  try {
    # Rank real LAN adapters: Up, with a default gateway, NOT a virtual/VPN NIC.
    # Prefer a private (RFC1918) IPv4 on the lowest interface metric, so a
    # Tailscale/VPN/Hyper-V/VMware adapter (which can also carry a gateway) does
    # not bake the wrong address into the cert SAN.
    $bad = "Hyper-V|Virtual|VMware|VirtualBox|Loopback|WSL|TAP-|Tailscale|WireGuard|ZeroTier|VPN|Bluetooth"
    $cands = @()
    foreach ($c in (Get-NetIPConfiguration)) {
      if ($null -eq $c.IPv4DefaultGateway) { continue }
      if ($c.NetAdapter.Status -ne "Up") { continue }
      if ($c.NetAdapter.InterfaceDescription -match $bad) { continue }
      $ip = ($c.IPv4Address | Select-Object -First 1).IPAddress
      if (-not $ip) { continue }
      $metric = 9999
      $mi = Get-NetIPInterface -InterfaceIndex $c.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($mi -and $mi.InterfaceMetric) { $metric = [int]$mi.InterfaceMetric }
      $private = $false
      if ($ip -match "^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)") { $private = $true }
      $cands += [pscustomobject]@{ Ip = $ip; Metric = $metric; Private = $private }
    }
    $best = $cands |
      Sort-Object @{ Expression = { if ($_.Private) { 0 } else { 1 } } }, Metric |
      Select-Object -First 1
    if ($best) { $LanIp = $best.Ip }
  } catch { $LanIp = "" }
  if ($LanIp -ne "") {
    Write-Host "Auto-detected LAN IP: $LanIp  (override with -LanIp if wrong)"
    if ($cands.Count -gt 1) { Write-Host "  Other candidates: $(($cands.Ip) -join ', ')" }
  } else {
    Write-Host "Could not auto-detect a LAN IP; cert will cover localhost only. Pass -LanIp yourself to reach it from another device."
  }
}

$san = "DNS:localhost,IP:127.0.0.1"
if ($LanIp -ne "") { $san = "$san,IP:$LanIp" }

$openssl = (Get-Command openssl -ErrorAction SilentlyContinue)
if ($null -eq $openssl) {
  $gitOpenssl = "C:\Program Files\Git\usr\bin\openssl.exe"
  if (Test-Path $gitOpenssl) { $openssl = $gitOpenssl } else {
    throw "OpenSSL not found. Install Git for Windows or OpenSSL, or use mkcert."
  }
} else {
  $openssl = $openssl.Source
}

& $openssl req -x509 -newkey rsa:2048 -nodes `
  -keyout (Join-Path $certDir "key.pem") `
  -out (Join-Path $certDir "cert.pem") `
  -days 365 `
  -subj "/CN=localhost" `
  -addext "subjectAltName=$san"

Write-Host "Created certs\cert.pem and certs\key.pem (SAN: $san)"
Write-Host "The server auto-detects certs\ - just run it; no .env wiring needed."
if ($LanIp -ne "") {
  Write-Host ""
  Write-Host "On your iPad (same Wi-Fi), open:  https://${LanIp}:8443"
  Write-Host "Safari will warn about the self-signed cert: tap Show Details -> visit this website, then Connect."
}
