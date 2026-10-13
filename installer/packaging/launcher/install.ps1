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

In Azure Cloud Shell's PowerShell, for tenants where no PC may run the installer, the same command
gets this release's commit from GitHub with git, installs the installer's packages with npm and
runs it in the terminal. It uses Cloud Shell's Node.js when that is 22.13 or later, or downloads
Node.js {{NODE_VERSION}} and checks it against nodejs.org's SHA-256 list. The installer goes under
~/.analytics-hub and the install record under ~/analytics-hub. -Uninstall removes the first.
Set $env:ANALYTICS_HUB_CLOUD_SHELL to 1 or 0 if Cloud Shell isn't detected, or is wrongly.

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

  # Azure Cloud Shell runs Linux, so the zip's Windows Node.js and packages are no use there.
  $CloudShell = $env:ANALYTICS_HUB_CLOUD_SHELL -eq '1' -or ($env:ANALYTICS_HUB_CLOUD_SHELL -ne '0' -and ([string]$env:AZUREPS_HOST_ENVIRONMENT -like 'cloud-shell*' -or [bool]$env:ACC_CLOUD))
  if ($CloudShell) {
    $Commit = '{{COMMIT}}'
    $NodeVersion = '{{NODE_VERSION}}'
    $RepoUrl = 'https://github.com/{{REPO}}.git'
    if ($ZipPath) { throw '-ZipPath is for Windows. In Cloud Shell the installer comes from GitHub.' }
    $AhHome = Join-Path $HOME '.analytics-hub'
    $Root = Join-Path $AhHome $Id
    $Shim = Join-Path $AhHome 'analytics-hub'
    $Work = Join-Path $HOME 'analytics-hub'
    $Marker = '.unpacked'
    $Sep = [IO.Path]::PathSeparator

    if ($Uninstall) {
      if (-not (Test-Path -LiteralPath $AhHome)) { Write-Host 'Nothing to remove.'; return }
      Remove-Item -LiteralPath $AhHome -Recurse -Force
      Write-Host "Removed $AhHome. Your install record in $Work is still there."
      return
    }

    function Invoke-Checked([string]$What, [scriptblock]$Run) {
      & $Run
      if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE." }
    }

    # Building the app needs Node.js 22.13 or later. Cloud Shell's own is used when it's new enough.
    $NodeExe = $null
    $NodeDir = $null
    $sys = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sys) {
      $v = [string](& $sys.Source --version 2>$null)
      if ($v -match '^v(\d+)\.(\d+)\.' -and ([int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 13))) { $NodeExe = $sys.Source }
    }
    if (-not $NodeExe) {
      $NodeDir = Join-Path $AhHome "node-v$NodeVersion-linux-x64"
      $NodeExe = Join-Path $NodeDir 'bin/node'
      if (-not (Test-Path -LiteralPath $NodeExe)) {
        if (-not $IsLinux -or [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'The installer needs Node.js 22.13 or later. Install it, then run this again.' }
        New-Item -ItemType Directory -Path $AhHome -Force | Out-Null
        $file = "node-v$NodeVersion-linux-x64.tar.gz"
        $base = "https://nodejs.org/dist/v$NodeVersion"
        $tgz = Join-Path $AhHome "$file.partial-$PID"
        $partial = "$NodeDir.partial-$PID"
        Write-Host "Cloud Shell's Node.js is older than 22.13, so downloading Node.js $NodeVersion for the installer..."
        try {
          Invoke-WebRequest -Uri "$base/$file" -OutFile $tgz -UseBasicParsing
          $want = $null
          foreach ($line in ([string](Invoke-RestMethod -Uri "$base/SHASUMS256.txt")) -split "`n") {
            $p = @($line.Trim() -split '\s+')
            if ($p.Count -eq 2 -and $p[1] -eq $file) { $want = $p[0].ToLowerInvariant() }
          }
          $got = (Get-FileHash -LiteralPath $tgz -Algorithm SHA256).Hash.ToLowerInvariant()
          if (-not $want -or $got -ne $want) { throw "The SHA-256 of $file is $got, which isn't the one nodejs.org lists for it." }
          New-Item -ItemType Directory -Path $partial -Force | Out-Null
          Invoke-Checked 'tar' { tar -x -z -f $tgz -C $partial --strip-components 1 }
          if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
          Rename-Item -LiteralPath $partial -NewName (Split-Path $NodeDir -Leaf)
        } finally {
          Remove-Item -LiteralPath $tgz -Force -ErrorAction SilentlyContinue
          if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue }
        }
      }
    }
    $NodeBin = Split-Path $NodeExe

    if (-not (Test-Path -LiteralPath (Join-Path $Root $Marker))) {
      if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'The installer needs git, which Azure Cloud Shell has.' }
      New-Item -ItemType Directory -Path $AhHome -Force | Out-Null
      $partial = "$Root.partial-$PID"
      if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }
      $savedPath = $env:PATH
      try {
        Write-Host "Getting the Analytics Hub installer $Version ($($Commit.Substring(0, 7))) from GitHub..."
        Invoke-Checked 'git init' { git init --quiet $partial }
        Invoke-Checked 'git fetch' { git -C $partial fetch --quiet --depth 1 $RepoUrl $Commit }
        Invoke-Checked 'git checkout' { git -C $partial -c advice.detachedHead=false checkout --quiet FETCH_HEAD }
        $head = ([string](git -C $partial rev-parse HEAD)).Trim()
        if ($head -ne $Commit) { throw "GitHub sent commit $head, not $Commit." }
        Write-Host "Installing the installer's packages..."
        $env:PATH = $NodeBin + $Sep + $env:PATH
        Push-Location -LiteralPath (Join-Path $partial 'installer')
        try { Invoke-Checked 'npm ci' { npm ci --omit=dev --no-audit --no-fund --loglevel=error } } finally { Pop-Location }
        Set-Content -LiteralPath (Join-Path $partial $Marker) -Value (Get-Date -Format o) -Encoding Ascii
        if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
        for ($try = 1; ; $try++) {
          try { Rename-Item -LiteralPath $partial -NewName $Id; break } catch { if ($try -ge 5) { throw }; Start-Sleep -Seconds 1 }
        }
      } catch {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue }
        throw "Couldn't get the installer: $($_.Exception.Message)"
      } finally {
        $env:PATH = $savedPath
      }
    }

    # Remove other versions, and a Node.js this version doesn't use.
    foreach ($dir in @(Get-ChildItem -LiteralPath $AhHome -Directory -ErrorAction SilentlyContinue)) {
      if ($dir.Name -eq $Id -or ($NodeDir -and $dir.FullName -eq $NodeDir)) { continue }
      if ($dir.Name -like '*.partial-*' -and $dir.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddHours(-1)) { continue }
      Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    # A command for later, such as "~/.analytics-hub/analytics-hub status", that runs this version.
    $shell = @(
      '#!/bin/sh'
      '# Runs the Analytics Hub installer that install.ps1 got. install.ps1 writes this file.'
      "AH_ROOT='$Root'"
      'if [ ! -f "$AH_ROOT/.unpacked" ]; then'
      "  echo 'This copy of the Analytics Hub installer has been removed or replaced. In PowerShell, run: $Again'"
      '  exit 1'
      'fi'
      'export ANALYTICS_HUB_LAUNCHER=cloudshell'
      "export PATH='$NodeBin'`"$Sep`$PATH`""
      "mkdir -p '$Work' && cd '$Work' || exit 1"
      "exec '$NodeExe' `"`$AH_ROOT/installer/bin/valuelens-install.js`" `"`$@`""
    )
    [IO.File]::WriteAllText($Shim, (($shell -join "`n") + "`n"))
    if (Get-Command chmod -CommandType Application -ErrorAction SilentlyContinue) { chmod +x $Shim }

    # Cloud Shell keeps $HOME between sessions only when it has a storage account, which mounts ~/clouddrive.
    if ($IsLinux -and -not (Test-Path -LiteralPath (Join-Path $HOME 'clouddrive'))) {
      Write-Warning "This Cloud Shell session has no storage account, so its files go when it ends, including the install record in $Work. Without the record, running the installer again sets up a second copy. Download the record before you close Cloud Shell, or use Cloud Shell with a storage account."
    }

    New-Item -ItemType Directory -Path $Work -Force | Out-Null
    $saved = @{ Launcher = $env:ANALYTICS_HUB_LAUNCHER; Path = $env:PATH }
    Push-Location -LiteralPath $Work
    try {
      $env:ANALYTICS_HUB_LAUNCHER = 'cloudshell'
      $env:PATH = $NodeBin + $Sep + $env:PATH
      & $NodeExe (Join-Path $Root 'installer/bin/valuelens-install.js') @Forward
      $global:LASTEXITCODE = $LASTEXITCODE
    } finally {
      Pop-Location
      $env:ANALYTICS_HUB_LAUNCHER = $saved.Launcher
      $env:PATH = $saved.Path
    }
    return
  }

  if ($env:OS -ne 'Windows_NT') { throw 'This launcher runs on Windows and in Azure Cloud Shell. Elsewhere, run the installer with Node.js: see "Without the exe" in installer/README.md.' }
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
      # No double quotes: Windows PowerShell 5.1 drops them from a native command's arguments.
      & $Node -e 'require(''fs'').rmSync(process.argv[1], { recursive: true, force: true })' $Dir
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
