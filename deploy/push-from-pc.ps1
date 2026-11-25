<#
 Windows helper: build the release on this PC, copy it to the server with scp, and run the installer over SSH.
 Needs: Node 22+, and the OpenSSH client that ships with Windows 10/11 (ssh, scp, tar).

 Example:
   .\deploy\push-from-pc.ps1 -Server 89.32.251.143 -Port 1242 -User root -Domain server1.iranoutdoor.com -Email you@example.com -VpsLocal -WithBridge

 Add -PreflightOnly first to just test the server's connectivity (changes nothing).
 NOTE: this script is untested on a real Windows machine — read it before running; every step is a plain command.
#>
param(
  [Parameter(Mandatory=$true)][string]$Server,
  [int]$Port = 22,
  [Parameter(Mandatory=$true)][string]$User,
  [string]$Domain = "",
  [string]$Email = "",
  [string]$Key = "",
  [switch]$VpsLocal,
  [switch]$WithBridge,
  [switch]$PreflightOnly,
  [switch]$BundleNode
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  $mk = @("deploy/make-release.mjs"); if ($BundleNode) { $mk += "--node" }
  node @mk
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  $archive = "release/iran-camping-hub-$($pkg.version).tar.gz"
  $sshOpts = @("-p", $Port); $scpOpts = @("-P", $Port)
  if ($Key) { $sshOpts += @("-i", $Key); $scpOpts += @("-i", $Key) }
  $target = "$User@$Server"
  Write-Host "Copying $archive to $target ..."
  scp @scpOpts $archive "${target}:/tmp/ich-release.tar.gz"
  $args = @()
  if ($PreflightOnly) { $args += "--preflight-only" }
  if ($Domain) { $args += @("--domain", $Domain) }
  if ($Email)  { $args += @("--email", $Email) }
  if ($VpsLocal) { $args += "--vps-local" }
  if ($WithBridge) { $args += "--with-bridge" }
  $sudo = if ($User -eq "root") { "" } else { "sudo " }
  $remote = "rm -rf /tmp/ich && mkdir -p /tmp/ich && tar -xzf /tmp/ich-release.tar.gz -C /tmp/ich && ${sudo}bash /tmp/ich/deploy/install.sh $($args -join ' ')"
  Write-Host "Running installer on the server ..."
  ssh @sshOpts -t $target $remote
} finally { Pop-Location }
