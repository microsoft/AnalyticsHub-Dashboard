<#
Analytics Hub installer {{VERSION}}, started from PowerShell.

Downloads the installer from GitHub (Node.js, the installer and everything it deploys, in one
zip), checks its SHA-256, unpacks it under %LOCALAPPDATA%\AnalyticsHub and opens the installer in
your browser. It needs no admin rights and installs nothing system-wide.

  irm https://github.com/{{REPO}}/releases/latest/download/install.ps1 | iex

Or download this file and run it:

  powershell -ExecutionPolicy Bypass -File .\install.ps1 [options] [installer command and options]

Options:
  -ZipPath <file>  Use an AnalyticsHubInstaller.zip you downloaded yourself, for example when a
                   proxy blocks GitHub's download host. It must be the zip from the same release.
  -Proxy <url>     Download through this proxy, signed in as you.
  -Uninstall       Remove the unpacked installer and its command. Your install record in
                   Documents\Analytics Hub stays.
Anything else goes to the installer, for example: status, or install --device-code.
With irm | iex, set $env:ANALYTICS_HUB_ZIP or $env:ANALYTICS_HUB_PROXY instead.

Works in Windows PowerShell 5.1 and PowerShell 7, including Constrained Language Mode. Generated
by installer/packaging/build-exe.js from installer/packaging/launcher/install.ps1.
#>
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $Version = '{{VERSION}}'
  $Sha256 = '{{SHA256}}'
  $Id = '{{PAYLOAD_ID}}'
  $ZipUrl = '{{ZIP_URL}}'
  $ZipName = '{{ZIP_NAME}}'
  $SizeMb = '{{SIZE_MB}}'
  $Again = 'irm https://github.com/{{REPO}}/releases/latest/download/install.ps1 | iex'

  # Launcher options; the rest go to the installer as typed.
  $ZipPath = $env:ANALYTICS_HUB_ZIP
  $Proxy = $env:ANALYTICS_HUB_PROXY
  $Uninstall = $false
  $Forward = @()
  for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -eq '-ZipPath' -and $i + 1 -lt $args.Count) { $i++; $ZipPath = [string]$args[$i] }
    elseif ($a -eq '-Proxy' -and $i + 1 -lt $args.Count) { $i++; $Proxy = [string]$args[$i] }
    elseif ($a -eq '-Uninstall') { $Uninstall = $true }
    else { $Forward += $a }
  }

  if ($env:OS -ne 'Windows_NT') { throw 'This launcher runs on Windows. Elsewhere, run the installer with Node.js: see installer/README.md.' }
  $FullLanguage = $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage'
  $AhHome = Join-Path $env:LOCALAPPDATA 'AnalyticsHub'
  $Root = Join-Path $AhHome $Id
  $Shim = Join-Path $AhHome 'analytics-hub.cmd'
  $Marker = '.unpacked'
  $Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

  # Removes a folder whose paths may run past 260 characters, with Node.js when it's there.
  function Remove-Tree([string]$Dir, [string]$Node) {
    if (-not (Test-Path -LiteralPath $Dir)) { return }
    if ($Node -and (Test-Path -LiteralPath $Node)) {
      & $Node -e 'require("fs").rmSync(process.argv[1], { recursive: true, force: true })' $Dir
      if ($LASTEXITCODE -eq 0) { return }
    }
    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
  }

  function Find-Node {
    Get-ChildItem -LiteralPath $AhHome -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'node\node.exe' } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
  }

  if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $AhHome)) { Write-Host 'Nothing to remove.'; return }
    $node = Find-Node
    if ($node) {
      # Node.js can't remove the folder it runs from, so run a copy.
      $copy = Join-Path $env:TEMP "analytics-hub-node-$PID.exe"
      Copy-Item -LiteralPath $node -Destination $copy -Force
      Remove-Tree $AhHome $copy
      Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Tree $AhHome $null
    }
    if (Test-Path -LiteralPath $AhHome) { throw "Couldn't remove all of $AhHome. Close the installer and try again." }
    Write-Host "Removed $AhHome. Your install record in Documents\Analytics Hub is still there."
    return
  }

  if (-not (Test-Path -LiteralPath (Join-Path $Root $Marker))) {
    New-Item -ItemType Directory -Path $AhHome -Force | Out-Null
    $zip = $ZipPath
    $downloaded = $false
    if ($zip) {
      if (-not (Test-Path -LiteralPath $zip)) { throw "Can't find $zip." }
      $zip = (Resolve-Path -LiteralPath $zip).Path
    } else {
      $zip = Join-Path $AhHome "$Id.zip.partial-$PID"
      $downloaded = $true
      Write-Host "Downloading the Analytics Hub installer $Version (about $SizeMb MB)..."
      if ($FullLanguage) {
        # Windows PowerShell 5.1 may not offer TLS 1.2 by default, and doesn't sign in to the system proxy.
        try {
          [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
          if ([Net.WebRequest]::DefaultWebProxy) { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
        } catch { }
      }
      $request = @{ Uri = $ZipUrl; OutFile = $zip; UseBasicParsing = $true }
      if ($Proxy) { $request.Proxy = $Proxy; $request.ProxyUseDefaultCredentials = $true }
      try {
        Invoke-WebRequest @request
      } catch {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        throw "Couldn't download $ZipUrl ($($_.Exception.Message)). If a proxy blocks it, download $ZipName from the release in a browser and run this again with -ZipPath, or set `$env:ANALYTICS_HUB_ZIP to its path."
      }
    }

    # Get-FileHash fails in Windows PowerShell 5.1's Constrained Language Mode; certutil ships with Windows.
    $actual = $null
    try { $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256 -ErrorAction Stop).Hash } catch { }
    if (-not $actual) {
      $lines = @(& (Join-Path $env:SystemRoot 'System32\certutil.exe') -hashfile $zip SHA256)
      if ($LASTEXITCODE -eq 0 -and $lines.Count -ge 2) { $actual = ([string]$lines[1]) -replace '\s', '' }
    }
    if (-not $actual) { throw "Couldn't work out the SHA-256 of $zip." }
    $actual = $actual.ToLowerInvariant()
    if ($actual -ne $Sha256) {
      if ($downloaded) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
      throw "$zip isn't the Analytics Hub installer $Version (its SHA-256 is $actual, not $Sha256). Download $ZipName from release installer-v$Version again."
    }

    Write-Host 'Unpacking it. This takes a minute the first time...'
    $partial = "$Root.partial-$PID"
    Remove-Tree $partial $null
    New-Item -ItemType Directory -Path $partial -Force | Out-Null
    try {
      if (Test-Path -LiteralPath $Tar) {
        # tar.exe writes through extended-length paths, which some dependencies need.
        & $Tar -x -f $zip -C $partial
        if ($LASTEXITCODE -ne 0) { throw "tar.exe failed with exit code $LASTEXITCODE." }
      } else {
        Expand-Archive -LiteralPath $zip -DestinationPath $partial -Force
      }
      Set-Content -LiteralPath (Join-Path $partial $Marker) -Value (Get-Date -Format o) -Encoding Ascii
    } catch {
      Remove-Tree $partial $null
      throw "Couldn't unpack the installer: $($_.Exception.Message)"
    } finally {
      if ($downloaded) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
    }
    try {
      # Left half unpacked by an earlier run that was stopped.
      if ((Test-Path -LiteralPath $Root) -and -not (Test-Path -LiteralPath (Join-Path $Root $Marker))) { Remove-Tree $Root (Join-Path $partial 'node\node.exe') }
      Rename-Item -LiteralPath $partial -NewName $Id
    } catch {
      # Another copy of the installer unpacked it first.
      if (-not (Test-Path -LiteralPath (Join-Path $Root $Marker))) { throw }
      Remove-Tree $partial (Join-Path $Root 'node\node.exe')
    }
  }

  $node = Join-Path $Root 'node\node.exe'
  $script = Join-Path $Root 'f\installer\bin\valuelens-install.js'

  # Remove what other versions unpacked, unless they're still running.
  foreach ($dir in @(Get-ChildItem -LiteralPath $AhHome -Directory -ErrorAction SilentlyContinue)) {
    if ($dir.Name -eq $Id) { continue }
    if ($dir.Name -like '*.partial-*' -and $dir.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddHours(-1)) { continue }
    $doomed = $dir.FullName
    if (-not $dir.Name.StartsWith('~')) {
      $doomed = Join-Path $AhHome ('~' + [string](Get-Random) + [string]$PID)
      # Moving it first fails while any file in it is in use, and leaves nothing half deleted.
      try { Rename-Item -LiteralPath $dir.FullName -NewName (Split-Path $doomed -Leaf) } catch { continue }
    }
    Remove-Item -LiteralPath (Join-Path $doomed $Marker) -Force -ErrorAction SilentlyContinue
    Remove-Tree $doomed $node
  }

  # The install record lives here, so every version of the installer finds it.
  $Docs = $null
  if ($FullLanguage) { try { $Docs = [Environment]::GetFolderPath('MyDocuments') } catch { } }
  if (-not $Docs) {
    $Docs = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -ErrorAction SilentlyContinue).Personal
  }
  if (-not $Docs) { $Docs = Join-Path $env:USERPROFILE 'Documents' }
  $Work = Join-Path $Docs 'Analytics Hub'
  New-Item -ItemType Directory -Path $Work -Force | Out-Null

  # A command for later, such as "analytics-hub.cmd status", that runs this version.
  Set-Content -LiteralPath $Shim -Encoding Ascii -Value @(
    '@echo off'
    'rem Runs the Analytics Hub installer that install.ps1 unpacked. install.ps1 writes this file.'
    'setlocal'
    "set `"AH_ROOT=%~dp0$Id`""
    'if not exist "%AH_ROOT%\.unpacked" ('
    "  echo This copy of the Analytics Hub installer has been removed or replaced. In PowerShell, run: $Again"
    '  exit /b 1'
    ')'
    'set "ANALYTICS_HUB_LAUNCHER=pwsh"'
    'set "PATH=%AH_ROOT%\node;%PATH%"'
    "cd /d `"$Work`""
    'if "%~1"=="" ("%AH_ROOT%\node\node.exe" "%AH_ROOT%\f\installer\bin\valuelens-install.js" --ui) else ("%AH_ROOT%\node\node.exe" "%AH_ROOT%\f\installer\bin\valuelens-install.js" %*)'
  )

  if (-not $Forward.Count) { $Forward = @('--ui') }
  $saved = @{ Launcher = $env:ANALYTICS_HUB_LAUNCHER; Path = $env:PATH }
  $awake = $false
  if ($FullLanguage) {
    # A PC that sleeps part way through setup stops it. Best effort: Add-Type may be blocked.
    try {
      if (-not ('AnalyticsHub.Power' -as [type])) {
        Add-Type -Namespace AnalyticsHub -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
      }
      $awake = [AnalyticsHub.Power]::SetThreadExecutionState([uint32]2147483649) -ne 0
    } catch { }
  }
  Push-Location -LiteralPath $Work
  try {
    $env:ANALYTICS_HUB_LAUNCHER = 'pwsh'
    $env:PATH = (Join-Path $Root 'node') + ';' + $env:PATH
    & $node $script @Forward
    $global:LASTEXITCODE = $LASTEXITCODE
  } finally {
    Pop-Location
    $env:ANALYTICS_HUB_LAUNCHER = $saved.Launcher
    $env:PATH = $saved.Path
    if ($awake) { try { [AnalyticsHub.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null } catch { } }
  }
} @args
if ($MyInvocation.MyCommand.Path -and $LASTEXITCODE) { exit $LASTEXITCODE }
