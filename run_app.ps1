Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Ensure .env exists at repo root (copy from server/.env.example)
if (-not (Test-Path (Join-Path $root '.env'))) {
  if (Test-Path (Join-Path $root 'server\.env.example')) {
    Copy-Item (Join-Path $root 'server\.env.example') (Join-Path $root '.env') -Force
    Write-Output "Copied server/.env.example to .env"
  } else {
    Write-Warning "No server/.env.example found to copy from."
  }
} else {
  Write-Output ".env already exists"
}

# Try to find and start the local PostgreSQL service
$svcCandidates = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue
$found = $false
foreach ($svc in $svcCandidates) {
  $found = $true
  if ($svc.Status -ne 'Running') {
    try {
      Start-Service -Name $svc.Name -ErrorAction Stop
      Write-Output "Started PostgreSQL service: $($svc.Name)"
    } catch {
      Write-Warning ("Failed to start service {0}: {1}" -f $svc.Name, $_.Exception.Message)
    }
  } else {
    Write-Output "PostgreSQL service $($svc.Name) is already running"
  }
  break
}

if (-not $found) {
  Write-Warning "No local PostgreSQL service was found. Skipping start step."
}

# Optionally install npm deps if missing
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Output "node_modules not found — running npm install..."
  npm install
} else {
  Write-Output "Dependencies present"
}

Write-Output "Launching application (npm start)..."
npm start
