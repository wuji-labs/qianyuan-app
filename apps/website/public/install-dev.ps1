param(
  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "dev" }),
  [switch] $SetupRelay,
  [switch] $WithDaemon,
  [switch] $WithoutDaemon,
  [string] $Run = $(if ($env:HAPPIER_INSTALLER_RUN_ACTION) { $env:HAPPIER_INSTALLER_RUN_ACTION } else { "" }),
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RunArgs = @()
)

$ErrorActionPreference = "Stop"

if ($WithDaemon.IsPresent -and $WithoutDaemon.IsPresent) {
  throw "Specify either -WithDaemon or -WithoutDaemon, not both."
}

if ($env:HAPPIER_INSTALLER_SETUP_RELAY -and $env:HAPPIER_INSTALLER_SETUP_RELAY -ne "0") {
  $SetupRelay = $true
}

function Normalize-Channel {
  param (
    [Parameter(Mandatory = $true)] [string] $Raw
  )
  $value = $Raw.Trim().ToLowerInvariant()
  if (-not $value) { return "stable" }
  switch ($value) {
    "stable" { return "stable" }
    "preview" { return "preview" }
    "dev" { return "publicdev" }
    "publicdev" { return "publicdev" }
    default { throw "Invalid HAPPIER_CHANNEL '$Raw'. Expected stable, preview, or dev." }
  }
}

$Channel = Normalize-Channel -Raw ([string]$Channel)

$Repo = if ($env:HAPPIER_GITHUB_REPO) { $env:HAPPIER_GITHUB_REPO } else { "happier-dev/happier" }
$Token = if ($env:HAPPIER_GITHUB_TOKEN) { $env:HAPPIER_GITHUB_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { "" }
$ReleaseAssetsDir = if ($env:HAPPIER_RELEASE_ASSETS_DIR) { $env:HAPPIER_RELEASE_ASSETS_DIR } else { "" }
$GitHubHeaders = @{
  "X-GitHub-Api-Version" = "2022-11-28"
}
if ($Token) {
  $GitHubHeaders["Authorization"] = "Bearer $Token"
}
$InstallDir = if ($env:HAPPIER_INSTALL_DIR) { $env:HAPPIER_INSTALL_DIR } elseif ($env:HAPPIER_HOME_DIR) { $env:HAPPIER_HOME_DIR } else { Join-Path $env:USERPROFILE ".happier" }
$DaemonServiceStateHomeDir = if ($env:HAPPIER_HOME_DIR) { $env:HAPPIER_HOME_DIR } else { $InstallDir }
$LegacyBinDir = Join-Path $env:USERPROFILE ".local\bin"
$BinDir = Join-Path $InstallDir "bin"
if ($env:HAPPIER_BIN_DIR) {
  $requestedBinDir = $env:HAPPIER_BIN_DIR
  if ($requestedBinDir -ne $BinDir) {
    Write-Warning "Ignoring HAPPIER_BIN_DIR on Windows; the managed install bin directory is the canonical PATH target."
  }
}
$Noninteractive = if ($env:HAPPIER_NONINTERACTIVE) { $env:HAPPIER_NONINTERACTIVE } else { "0" }
$WithDaemonExplicit = $false
if ($WithDaemon.IsPresent) {
  $WithDaemonPreference = "1"
  $WithDaemonExplicit = $true
}
elseif ($WithoutDaemon.IsPresent) {
  $WithDaemonPreference = "0"
  $WithDaemonExplicit = $true
}
elseif ($env:HAPPIER_WITH_DAEMON) {
  $WithDaemonPreference = $env:HAPPIER_WITH_DAEMON
  $WithDaemonExplicit = $true
}
else {
  $WithDaemonPreference = "0"
}
$DefaultMinisignPubKey = @"
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
"@
$MinisignPubKey = if ($env:HAPPIER_MINISIGN_PUBKEY) { $env:HAPPIER_MINISIGN_PUBKEY } else { $DefaultMinisignPubKey.Trim() }
$MinisignPubKeyUrl = if ($env:HAPPIER_MINISIGN_PUBKEY_URL) { $env:HAPPIER_MINISIGN_PUBKEY_URL } else { "https://happier.dev/happier-release.pub" }

function Resolve-CliShimName {
  if ($Channel -eq "preview") { return "hprev" }
  if ($Channel -eq "publicdev") { return "hdev" }
  return "happier"
}

function Resolve-InstalledCliInvoker {
  $shim = Resolve-CliShimName

  $candidates = @(
    (Join-Path $BinDir "$shim.exe"),
    (Join-Path $BinDir $shim),
    (Join-Path $InstallDir "bin\\$shim.exe"),
    (Join-Path $InstallDir "bin\\$shim")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  foreach ($name in @($shim, "$shim.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
      return $cmd.Source
    }
  }

  return $null
}

function Show-PathReloadGuidance {
  param (
    [Parameter(Mandatory = $true)] [string] $ShimName,
    [Parameter(Mandatory = $true)] [string] $BinDir
  )

  Write-Host ""
  Write-Host "Next steps"
  Write-Host "The current PowerShell session can use $ShimName immediately."
  Write-Host "Other already-open terminals keep their old PATH until you restart them."
  Write-Host "Managed bin directory: $BinDir"
}

function ConvertTo-InstallerBoolean {
  param (
    [Parameter(Mandatory = $true)] [string] $Raw
  )

  $value = $Raw.Trim().ToLowerInvariant()
  switch ($value) {
    "1" { return "1" }
    "true" { return "1" }
    "yes" { return "1" }
    "on" { return "1" }
    "0" { return "0" }
    "false" { return "0" }
    "no" { return "0" }
    "off" { return "0" }
    "" { return "0" }
    default { throw "Invalid HAPPIER_WITH_DAEMON value '$Raw'. Expected 0/1, true/false, yes/no, or on/off." }
  }
}

function Get-DefaultBackgroundServiceChoice {
  if ($Noninteractive -eq "1") {
    return "0"
  }
  if ($Channel -eq "stable") {
    return "1"
  }
  return "0"
}

function Test-InteractiveInstallerPromptAvailable {
  if ($Noninteractive -eq "1") {
    return $false
  }
  try {
    return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  }
  catch {
    return $false
  }
}

function Get-InstallerDisplayChannelLabel {
  param (
    [Parameter(Mandatory = $true)] [string] $Value
  )

  if ($Value -eq "publicdev" -or $Value -eq "dev") {
    return "dev"
  }

  return $Value
}

function Write-InstallerBullet {
  param (
    [Parameter(Mandatory = $true)] [string] $Text,
    [ConsoleColor] $Color
  )

  if ($PSBoundParameters.ContainsKey('Color')) {
    Write-Host "  • $Text" -ForegroundColor $Color
    return
  }

  Write-Host "  • $Text"
}

function Write-InstallerDetailBullet {
  param (
    [Parameter(Mandatory = $true)] [string] $Label,
    [Parameter(Mandatory = $true)] [string] $Value
  )

  Write-Host "    • " -NoNewline -ForegroundColor DarkGray
  Write-Host "$Label:" -NoNewline -ForegroundColor Gray
  Write-Host " $Value"
}

function Read-BackgroundServicePromptChoice {
  param (
    [Parameter(Mandatory = $true)] [string] $DefaultChoice,
    [Parameter(Mandatory = $true)] [bool] $HasExistingServices
  )

  if (-not (Test-InteractiveInstallerPromptAvailable)) {
    return $DefaultChoice
  }

  $channelLabel = Get-InstallerDisplayChannelLabel -Value $Channel
  $defaultHint = "y/N"
  $recommendedNote = "recommended: no"
  if ($DefaultChoice -eq "1") {
    $defaultHint = "Y/n"
    $recommendedNote = "recommended: yes"
  }

  $prompt = "Set up automatic startup for the $channelLabel CLI?"
  if ($HasExistingServices) {
    $prompt = "Update automatic startup for the $channelLabel CLI?"
  }

  while ($true) {
    $answer = Read-Host "$prompt [$defaultHint] ($recommendedNote)"
    $normalized = ([string]$answer).Trim().ToLowerInvariant()
    switch ($normalized) {
      "" { return $DefaultChoice }
      "y" { return "1" }
      "yes" { return "1" }
      "n" { return "0" }
      "no" { return "0" }
      default { Write-Warning "Please answer yes or no." }
    }
  }
}

function Read-InstallerYesNoChoice {
  param (
    [Parameter(Mandatory = $true)] [string] $Prompt,
    [Parameter(Mandatory = $true)] [string] $DefaultChoice
  )

  if (-not (Test-InteractiveInstallerPromptAvailable)) {
    return $DefaultChoice
  }

  $defaultHint = "y/N"
  $recommendedNote = "recommended: no"
  if ($DefaultChoice -eq "1") {
    $defaultHint = "Y/n"
    $recommendedNote = "recommended: yes"
  }

  while ($true) {
    $answer = Read-Host "$Prompt [$defaultHint] ($recommendedNote)"
    $normalized = ([string]$answer).Trim().ToLowerInvariant()
    switch ($normalized) {
      "" { return $DefaultChoice }
      "y" { return "1" }
      "yes" { return "1" }
      "n" { return "0" }
      "no" { return "0" }
      default { Write-Warning "Please answer yes or no." }
    }
  }
}

function Resolve-WithDaemonPreference {
  param (
    [Parameter(Mandatory = $false)] [object[]] $Entries = @()
  )

  if ($WithDaemonExplicit) {
    return ConvertTo-InstallerBoolean -Raw ([string]$WithDaemonPreference)
  }

  $defaultChoice = Get-DefaultBackgroundServiceChoice
  $hasExistingServices = $Entries.Count -gt 0
  if ($Noninteractive -eq "1") {
    if ($hasExistingServices) {
      return "1"
    }
    return $defaultChoice
  }

  if ($hasExistingServices -and (Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $Entries)) {
    return "0"
  }

  return Read-BackgroundServicePromptChoice -DefaultChoice $defaultChoice -HasExistingServices $hasExistingServices
}

function Invoke-InstallerCommandWithDaemonServiceContext {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath,
    [Parameter(Mandatory = $true)] [string[]] $CommandArgs,
    [Parameter(Mandatory = $true)] [string] $HomeDir
  )

  $previousHomeDir = $env:HAPPIER_HOME_DIR
  $previousNoninteractive = $env:HAPPIER_NONINTERACTIVE
  $previousPublicReleaseChannel = $env:HAPPIER_PUBLIC_RELEASE_CHANNEL
  $previousDaemonServiceChannel = $env:HAPPIER_DAEMON_SERVICE_CHANNEL
  $previousInstallerDaemonServiceStrategy = $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY
  try {
    $channelLabel = if ($Channel -eq "publicdev") { "dev" } else { $Channel }
    $env:HAPPIER_HOME_DIR = $HomeDir
    if ($null -eq $previousNoninteractive) {
      Remove-Item Env:HAPPIER_NONINTERACTIVE -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_NONINTERACTIVE = $previousNoninteractive
    }
    $env:HAPPIER_PUBLIC_RELEASE_CHANNEL = $channelLabel
    $env:HAPPIER_DAEMON_SERVICE_CHANNEL = $channelLabel
    if ($env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY) {
      $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY = $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY
    }
    & $CliPath @CommandArgs
  }
  finally {
    if ($null -eq $previousHomeDir) {
      Remove-Item Env:HAPPIER_HOME_DIR -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_HOME_DIR = $previousHomeDir
    }
    if ($null -eq $previousNoninteractive) {
      Remove-Item Env:HAPPIER_NONINTERACTIVE -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_NONINTERACTIVE = $previousNoninteractive
    }
    if ($null -eq $previousPublicReleaseChannel) {
      Remove-Item Env:HAPPIER_PUBLIC_RELEASE_CHANNEL -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_PUBLIC_RELEASE_CHANNEL = $previousPublicReleaseChannel
    }
    if ($null -eq $previousDaemonServiceChannel) {
      Remove-Item Env:HAPPIER_DAEMON_SERVICE_CHANNEL -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_DAEMON_SERVICE_CHANNEL = $previousDaemonServiceChannel
    }
    if ($null -eq $previousInstallerDaemonServiceStrategy) {
      Remove-Item Env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY = $previousInstallerDaemonServiceStrategy
    }
  }
}

function Get-InstalledBackgroundServiceInventory {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  try {
    $raw = Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("doctor", "repair", "--json") -HomeDir $DaemonServiceStateHomeDir | Out-String
    if (-not $raw) {
      throw "missing doctor repair preflight payload"
    }
    $payload = $raw | ConvertFrom-Json
    $propertyNames = @($payload.PSObject.Properties.Name)
    $entries = if ($propertyNames -contains 'entries') { @($payload.entries) } elseif ($propertyNames -contains 'existingServices') { @($payload.existingServices) } else { @() }
    $services = if ($propertyNames -contains 'services') { @($payload.services) } elseif ($propertyNames -contains 'existingServices') { @($payload.existingServices) } else { @() }
    if ($entries.Count -gt 0 -or $services.Count -gt 0 -or $propertyNames -contains 'existingServices' -or $propertyNames -contains 'entries' -or $propertyNames -contains 'services') {
      return @{
        Supported = $true
        RepairSupported = $true
        Entries = $entries
        Services = $services
        DaemonStatus = if ($propertyNames -contains 'daemonStatus') { $payload.daemonStatus } else { $null }
        Relays = if ($propertyNames -contains 'relays') { @($payload.relays) } else { @() }
        Payload = $payload
      }
    }
  }
  catch {
    try {
      $raw = Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "list", "--json") -HomeDir $DaemonServiceStateHomeDir | Out-String
      if (-not $raw) {
        return @{
          Supported = $false
          RepairSupported = $false
          Entries = @()
          Services = @()
          DaemonStatus = $null
          Relays = @()
          Payload = $null
        }
      }
      $payload = $raw | ConvertFrom-Json
      $propertyNames = @($payload.PSObject.Properties.Name)
      $entries = if ($propertyNames -contains 'entries') { @($payload.entries) } else { @() }
      $services = if ($propertyNames -contains 'services') { @($payload.services) } else { @() }
      if ($entries.Count -gt 0 -or $services.Count -gt 0 -or $propertyNames -contains 'entries' -or $propertyNames -contains 'services') {
        return @{
          Supported = $true
          RepairSupported = $false
          Entries = $entries
          Services = $services
          DaemonStatus = $null
          Relays = @()
          Payload = $payload
        }
      }
    }
    catch {
      return @{
        Supported = $false
        RepairSupported = $false
        Entries = @()
        Services = @()
        DaemonStatus = $null
        Relays = @()
        Payload = $null
      }
    }
  }

  return @{
    Supported = $false
    RepairSupported = $false
    Entries = @()
    Services = @()
    DaemonStatus = $null
    Relays = @()
    Payload = $null
  }
}

function Get-BackgroundServiceReportText {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $reportResult = Invoke-NativeCommandCapturingOutput {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("doctor", "repair", "--report-only") -HomeDir $DaemonServiceStateHomeDir
  }
  if ($reportResult.ExitCode -eq 0) {
    return [string]$reportResult.Output
  }
  if (Test-InstallerCommandLooksUnsupported -Output $reportResult.Output) {
    return ""
  }
  return ""
}

function Test-BackgroundServiceInventoryHasDefaultFollowing {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  return @($Entries | Where-Object { $_.targetMode -eq 'default-following' }).Count -gt 0
}

function Get-BackgroundServiceDefaultFollowingChannel {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  $entry = @($Entries | Where-Object { $_.targetMode -eq 'default-following' } | Select-Object -First 1)
  if ($entry.Count -eq 0 -or -not $entry[0].releaseChannel) {
    return ""
  }

  return Get-InstallerDisplayChannelLabel -Value ([string]$entry[0].releaseChannel)
}

function Test-BackgroundServiceInventoryHasMatchingDefaultFollowing {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  $defaultChannel = Get-BackgroundServiceDefaultFollowingChannel -Entries $Entries
  if (-not $defaultChannel) {
    return $false
  }

  return $defaultChannel -eq (Get-InstallerDisplayChannelLabel -Value $Channel)
}

function Show-BackgroundServiceStartupSummary {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  $defaultChannel = Get-BackgroundServiceDefaultFollowingChannel -Entries $Entries
  if ($defaultChannel) {
    if (Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $Entries) {
      Write-InstallerBullet -Text "Automatic startup follows the $defaultChannel channel." -Color Cyan
    }
    else {
      Write-InstallerBullet -Text "Automatic startup currently follows the $defaultChannel channel." -Color Cyan
    }
    return
  }

  Write-InstallerBullet -Text "Automatic startup is controlled by the installed background services above." -Color Cyan
  Write-InstallerBullet -Text "Installing this CLI does not change automatic startup by itself." -Color Cyan
}

function Show-InstalledBackgroundServiceSummary {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath,
    [Parameter(Mandatory = $true)] [object[]] $Entries,
    [Parameter()] [object] $Inventory
  )

  if ($Entries.Count -eq 0) {
    return
  }

  Write-Host ""
  Write-Host "Automatic Startup"
  Write-Host "  Installed background services:"
  $displayInventory = if ($null -ne $Inventory) { $Inventory } else { Get-InstalledBackgroundServiceInventory -CliPath $CliPath }
  $displayEntries = if ($displayInventory.Supported -and $displayInventory.Services.Count -gt 0) { @($displayInventory.Services) } else { @() }
  if ($displayEntries.Count -eq 0) {
    $displayEntries = @($Entries)
  }

  foreach ($entry in $displayEntries) {
    $serviceName = if ($entry.name) {
      [string]$entry.name
    }
    elseif ($entry.targetMode -eq 'default-following') {
      'Default background service'
    }
    elseif ($entry.serverId) {
      [string]$entry.serverId
    }
    else {
      'Background service'
    }

    Write-InstallerBullet -Text $serviceName -Color White
    $serviceChannel = if ($entry.releaseChannel) {
      [string]$entry.releaseChannel
    }
    elseif ($entry.ring) {
      [string]$entry.ring
    }
    else {
      ""
    }
    if ($serviceChannel) {
      Write-InstallerDetailBullet -Label "Release channel" -Value "$(Get-InstallerDisplayChannelLabel -Value $serviceChannel)"
    }
    if ($entry.serverId) {
      Write-InstallerDetailBullet -Label "Relay profile" -Value "$([string]$entry.serverId)"
    }
    if ($entry.mode) {
      Write-InstallerDetailBullet -Label "Service scope" -Value "$([string]$entry.mode)"
    }
    if ($entry.targetMode -eq 'default-following') {
      Write-InstallerDetailBullet -Label "Startup mode" -Value "follows the selected release channel"
    }
    elseif ($entry.targetMode -eq 'pinned') {
      Write-InstallerDetailBullet -Label "Startup mode" -Value "pinned to this release channel"
    }
    if ($null -ne $entry.running) {
      $runningNow = if ($entry.running -eq $true) { 'yes' } else { 'no' }
      Write-InstallerDetailBullet -Label "Running now" -Value $runningNow
    }
    if ($entry.configuredCliVersion) {
      Write-InstallerDetailBullet -Label "Configured CLI version" -Value "$([string]$entry.configuredCliVersion)"
    }
    if ($entry.runningCliVersion) {
      Write-InstallerDetailBullet -Label "Running CLI version" -Value "$([string]$entry.runningCliVersion)"
    }
    if ($entry.path) {
      Write-InstallerDetailBullet -Label "Installed at" -Value "$([string]$entry.path)"
    }
  }

  $status = if ($null -ne $displayInventory.DaemonStatus) { $displayInventory.DaemonStatus } else { $null }
  $preflightPayload = $displayInventory.Payload
  if ($null -eq $status) {
    try {
      $rawStatus = Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "status", "--json") -HomeDir $DaemonServiceStateHomeDir | Out-String
      if ($rawStatus) {
        $status = $rawStatus | ConvertFrom-Json
      }
    }
    catch {
      $status = $null
    }
  }

  $daemonRunning = if ($null -ne $preflightPayload -and $null -ne $preflightPayload.daemonRunning) { $preflightPayload.daemonRunning } elseif ($null -ne $status -and $null -ne $status.daemon) { $status.daemon.running } else { $null }
  $daemonPid = if ($null -ne $preflightPayload -and $null -ne $preflightPayload.daemonPid) { $preflightPayload.daemonPid } elseif ($null -ne $status -and $null -ne $status.daemon) { $status.daemon.pid } else { $null }
  $daemonServiceManaged = if ($null -ne $preflightPayload -and $null -ne $preflightPayload.daemonServiceManaged) { $preflightPayload.daemonServiceManaged } elseif ($null -ne $status.owner) { $status.owner.serviceManaged } elseif ($null -ne $status.daemon) { $status.daemon.serviceManaged } else { $null }
  $daemonStartedWithPublicReleaseChannel = if ($null -ne $preflightPayload -and $preflightPayload.daemonStartedWithPublicReleaseChannel) { [string]$preflightPayload.daemonStartedWithPublicReleaseChannel } elseif ($null -ne $status.owner -and $status.owner.startedWithPublicReleaseChannel) { [string]$status.owner.startedWithPublicReleaseChannel } elseif ($null -ne $status.daemon -and $status.daemon.startedWithPublicReleaseChannel) { [string]$status.daemon.startedWithPublicReleaseChannel } else { "" }
  $daemonStartedWithCliVersion = if ($null -ne $preflightPayload -and $preflightPayload.daemonStartedWithCliVersion) { [string]$preflightPayload.daemonStartedWithCliVersion } elseif ($null -ne $status.owner -and $status.owner.startedWithCliVersion) { [string]$status.owner.startedWithCliVersion } elseif ($null -ne $status.daemon -and $status.daemon.startedWithCliVersion) { [string]$status.daemon.startedWithCliVersion } else { "" }
  $daemonCurrentInvocationMatches = if ($null -ne $preflightPayload -and $null -ne $preflightPayload.daemonCurrentInvocationMatches) { $preflightPayload.daemonCurrentInvocationMatches } elseif ($null -ne $status.owner) { $status.owner.currentInvocationMatches } else { $null }

  if ($null -ne $status -or $null -ne $daemonRunning) {
    Write-Host ""
    Write-Host "  Current daemon status:"
    if ($daemonRunning -ne $true) {
      Write-InstallerBullet -Text "No daemon is currently running for the selected relay."
    }
    else {
      if ($null -ne $daemonPid) {
        Write-InstallerBullet -Text "Running now: yes (pid $daemonPid)"
      }
      else {
        Write-InstallerBullet -Text "Running now: yes"
      }

      if ($null -ne $daemonServiceManaged) {
        $ownerLabel = if ($daemonServiceManaged -eq $true) {
          'background service'
        }
        elseif ($daemonServiceManaged -eq $false) {
          'manual daemon start'
        }
        else {
          'unknown'
        }
        Write-InstallerBullet -Text "Started by: $ownerLabel"

        if ($daemonStartedWithPublicReleaseChannel -or $daemonStartedWithCliVersion) {
          $ownerChannel = if ($daemonStartedWithPublicReleaseChannel) { Get-InstallerDisplayChannelLabel -Value $daemonStartedWithPublicReleaseChannel } else { 'unknown' }
          $ownerVersion = if ($daemonStartedWithCliVersion) { $daemonStartedWithCliVersion } else { 'unknown' }
          Write-InstallerBullet -Text "Running CLI: $ownerChannel • $ownerVersion"
        }

        if ($null -eq $daemonCurrentInvocationMatches -and $daemonRunning -eq $true) {
          $channelLabel = Get-InstallerDisplayChannelLabel -Value $Channel
          $releaseChannelMismatch = $false
          if ($daemonStartedWithPublicReleaseChannel) {
            $releaseChannelMismatch = (Get-InstallerDisplayChannelLabel -Value $daemonStartedWithPublicReleaseChannel) -ne $channelLabel
          }
          $versionMismatch = $false
          if ($daemonStartedWithCliVersion) {
            $versionMismatch = $daemonStartedWithCliVersion -ne $Version
          }
          $daemonCurrentInvocationMatches = -not ($releaseChannelMismatch -or $versionMismatch)
        }

        if ($daemonCurrentInvocationMatches -eq $false) {
          $channelLabel = Get-InstallerDisplayChannelLabel -Value $Channel
          $ownerChannelLabel = if ($daemonStartedWithPublicReleaseChannel) {
            Get-InstallerDisplayChannelLabel -Value $daemonStartedWithPublicReleaseChannel
          }
          else {
            ""
          }

          if ($daemonServiceManaged -eq $true) {
            if ((Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $Entries) -and $ownerChannelLabel -and $ownerChannelLabel -eq $channelLabel) {
              Write-Host "The running background service is already on the $channelLabel channel. Restart it only if you want this new install to take over immediately." -ForegroundColor Yellow
            }
            else {
              Write-Host "The running background service is not using this installation yet. Use `happier service restart` if you want this new install to take over immediately." -ForegroundColor Yellow
            }
          }
          elseif ($daemonServiceManaged -eq $false) {
            Write-Host "The current daemon was started manually, not from automatic startup. Use `happier daemon restart` if you want the manual daemon to switch to this installation." -ForegroundColor Yellow
          }
          else {
            Write-Host "The running daemon is different from this installation. Restart the current daemon before trying to switch this installation." -ForegroundColor Yellow
          }
        }
      }
    }
  }

  Write-Host ""
  Show-BackgroundServiceStartupSummary -Entries $Entries
}

function Show-InstalledLocalRelaySummary {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Relays
  )

  if ($Relays.Count -eq 0) {
    return
  }

  Write-Host ""
  Write-Host "Local relays:"
  foreach ($relay in $Relays) {
    $relayRing = if ($relay.ring) { Get-InstallerDisplayChannelLabel -Value ([string]$relay.ring) } else { 'unknown' }
    $relayScope = if ($relay.scope) { [string]$relay.scope } else { 'unknown' }
    $relayUrl = if ($relay.relayUrl) { [string]$relay.relayUrl } else { 'unknown' }
    Write-InstallerBullet -Text "$relayRing ($relayScope) → $relayUrl" -Color White
    if ($relay.version) {
      Write-InstallerDetailBullet -Label "Version" -Value "$([string]$relay.version)"
    }
    $serviceState = if ($relay.serviceActive -eq $true) { 'running' } elseif ($relay.serviceActive -eq $false) { 'stopped' } else { 'unknown' }
    if ($relay.serviceEnabled -eq $true) {
      $serviceState = "$serviceState, enabled"
    }
    elseif ($relay.serviceEnabled -eq $false) {
      $serviceState = "$serviceState, disabled"
    }
    Write-InstallerDetailBullet -Label "Service" -Value $serviceState
    $health = if ($relay.healthy -eq $true) { 'healthy' } elseif ($relay.healthy -eq $false) { 'unhealthy' } else { 'unknown' }
    Write-InstallerDetailBullet -Label "Health" -Value $health
  }
}

function Test-InstallerCommandLooksUnsupported {
  param (
    [Parameter()] [string] $Output = ""
  )

  return $Output -match '(?i)unknown (option|command|subcommand)|invalid option|usage: happier <command>|does not support'
}

function Get-BackgroundServiceInstallManualCommand {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  return "$CliPath service install"
}

function Invoke-BackgroundServiceInstallCompatibly {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $installResult = Invoke-NativeCommandCapturingOutput {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "install", "--yes") -HomeDir $DaemonServiceStateHomeDir
  }
  if ($installResult.ExitCode -eq 0) {
    return @{
      Ok = $true
      Output = $installResult.Output
    }
  }

  if (Test-InstallerCommandLooksUnsupported -Output $installResult.Output) {
    $legacyInstallResult = Invoke-NativeCommandCapturingOutput {
      Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "install") -HomeDir $DaemonServiceStateHomeDir
    }
    if ($legacyInstallResult.ExitCode -eq 0) {
      return @{
        Ok = $true
        Output = $legacyInstallResult.Output
      }
    }
    return @{
      Ok = $false
      Output = $legacyInstallResult.Output
    }
  }

  return @{
    Ok = $false
    Output = $installResult.Output
  }
}

function Invoke-DoctorRepairIfSupported {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $repairResult = Invoke-NativeCommandCapturingOutput {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("doctor", "repair", "--yes") -HomeDir $DaemonServiceStateHomeDir
  }
  if ($repairResult.ExitCode -eq 0) {
    return @{
      Status = 'applied'
      Output = $repairResult.Output
    }
  }
  if (Test-InstallerCommandLooksUnsupported -Output $repairResult.Output) {
    return @{
      Status = 'unsupported'
      Output = $repairResult.Output
    }
  }
  return @{
    Status = 'failed'
    Output = $repairResult.Output
  }
}

function Resolve-ExistingBackgroundServiceInstallStrategy {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  if ($Noninteractive -eq "1") {
    return ""
  }

  if ($Entries.Count -eq 0) {
    return ""
  }

  if (Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $Entries) {
    return "skip"
  }

  $replacePrompt = "Use this installation for automatic startup?"
  if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $Entries) {
    $replacePrompt = "Use this installation for automatic startup?"
  }

  $replaceChoice = Read-InstallerYesNoChoice -Prompt $replacePrompt -DefaultChoice "1"
  if ($replaceChoice -eq "1") {
    return "replace-all"
  }

  if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $Entries) {
    return "skip"
  }

  $addChoice = Read-InstallerYesNoChoice -Prompt "Install an additional background service alongside the existing one(s)?" -DefaultChoice "0"
  if ($addChoice -eq "1") {
    return "add"
  }

  return "skip"
}

function Get-SupportedSetupRelayDefaultArgs {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $defaultArgs = @("--mode", "user", "--yes", "--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }), "--preserve-active-server")
  $helpResult = Invoke-NativeCommandCapturingOutput {
    & $CliPath relay host install --help
  }
  $helpOutput = [string]$helpResult.Output
  if ([string]::IsNullOrWhiteSpace($helpOutput)) {
    return $defaultArgs
  }

  $filteredArgs = @()
  if ($helpOutput -match '(?m)--mode\b') {
    $filteredArgs += @("--mode", "user")
  }
  if ($helpOutput -match '(?m)--yes\b') {
    $filteredArgs += @("--yes")
  }
  if ($helpOutput -match '(?m)--channel\b') {
    $filteredArgs += @("--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }))
  }
  if ($helpOutput -match '(?m)--preserve-active-server\b') {
    $filteredArgs += @("--preserve-active-server")
  }
  return $filteredArgs
}

function Invoke-PostInstallAction {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $setupRelayDefaultArgs = @()
  if ($SetupRelay -and -not $Run) {
    $Run = "setup-relay"
  }
  if (-not $Run) {
    return
  }

  $runValue = $Run.Trim().ToLowerInvariant()
  if ($runValue -eq "setup-relay" -and $setupRelayDefaultArgs.Count -eq 0) {
    $setupRelayDefaultArgs = Get-SupportedSetupRelayDefaultArgs -CliPath $CliPath
  }
  $requiredSubcommand = $null
  $argsToPass = @()
  switch ($runValue) {
    "setup-relay" {
      $argsToPass = @("relay", "host", "install") + $setupRelayDefaultArgs + $RunArgs
      $requiredSubcommand = "relay"
    }
    "relay-host-install" {
      $argsToPass = @("relay", "host", "install") + $RunArgs
      $requiredSubcommand = "relay"
    }
    "setup" {
      $argsToPass = @("setup") + $RunArgs
      $requiredSubcommand = "setup"
    }
    "auth-login" {
      $argsToPass = @("auth", "login") + $RunArgs
      $requiredSubcommand = "auth"
    }
    "service-install" {
      $argsToPass = @("service", "install") + $RunArgs
      $requiredSubcommand = "service"
    }
    "daemon-install" {
      $argsToPass = @("service", "install") + $RunArgs
      $requiredSubcommand = "service"
    }
    "providers-setup" {
      $argsToPass = @("providers", "setup") + $RunArgs
      $requiredSubcommand = "providers"
    }
    default {
      throw "Unknown -Run action '$Run'. Expected one of: setup-relay, setup, auth-login, service-install, providers-setup."
    }
  }

  if ($requiredSubcommand) {
    $invokerName = (Split-Path -Leaf $CliPath)
    if ([string]::IsNullOrWhiteSpace($invokerName)) { $invokerName = "happier" }
    $helpOutput = ""
    try {
      if ($requiredSubcommand -eq "relay") {
        $helpOutput = (& $CliPath relay --help 2>$null | Out-String)
      } else {
        $helpOutput = (& $CliPath --help 2>$null | Out-String)
      }
    } catch {
      $helpOutput = ""
    }
    $pattern = "(?m)^\\s*($([Regex]::Escape($invokerName))|happier)\\s+$([Regex]::Escape($requiredSubcommand))\\b"
    if (-not ($helpOutput -match $pattern)) {
      throw "Installed Happier CLI does not support the '$requiredSubcommand' command surface required for -Run $runValue. Update your Happier CLI (or switch installer channel) and try again."
    }
  }
  Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs $argsToPass -HomeDir $DaemonServiceStateHomeDir
}

if ($Run -and -not $SetupRelay -and ($existing = Resolve-InstalledCliInvoker)) {
  Invoke-PostInstallAction -CliPath $existing
  exit 0
}

function Get-AssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  return $Release.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
}

function Get-LocalAssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  if (-not $ReleaseAssetsDir) {
    return $null
  }
  if (-not (Test-Path $ReleaseAssetsDir -PathType Container)) {
    throw "HAPPIER_RELEASE_ASSETS_DIR does not exist: $ReleaseAssetsDir"
  }
  return Get-ChildItem -Path $ReleaseAssetsDir -File | Where-Object { $_.Name -match $Pattern } | Select-Object -First 1
}

function Resolve-InstallerAsset {
  param (
    [Parameter(Mandatory = $false)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  $localAsset = Get-LocalAssetByPattern -Pattern $Pattern
  if ($localAsset) {
    return @{
      Name = $localAsset.Name
      Source = $localAsset.FullName
    }
  }

  $asset = Get-AssetByPattern -Release $Release -Pattern $Pattern
  if (-not $asset) {
    return $null
  }
  return @{
    Name = [string]$asset.name
    Source = [string]$asset.browser_download_url
  }
}

function Copy-OrDownloadInstallerAsset {
  param (
    [Parameter(Mandatory = $true)] [string] $Source,
    [Parameter(Mandatory = $true)] [string] $DestinationPath
  )
  if (Test-Path $Source) {
    Copy-Item -Path $Source -Destination $DestinationPath -Force
    return
  }
  Invoke-InstallerWebRequestWithRetry -Uri $Source -Headers $GitHubHeaders -OutFile $DestinationPath
}

function Test-InstallerTransientWebException {
  param (
    [Parameter(Mandatory = $true)] [System.Management.Automation.ErrorRecord] $ErrorRecord
  )

  $retryableStatusCodes = @(502, 503, 504)
  $exception = $ErrorRecord.Exception
  $statusCode = $null
  if ($exception -and $exception.Response -and $exception.Response.StatusCode) {
    try {
      $statusCode = [int]$exception.Response.StatusCode
    }
    catch {
      $statusCode = $null
    }
  }
  if ($null -ne $statusCode -and $retryableStatusCodes -contains $statusCode) {
    return $true
  }

  $message = if ($exception) { [string]$exception.Message } else { [string]$ErrorRecord }
  foreach ($code in $retryableStatusCodes) {
    if ($message -match "(^|\\D)$code(\\D|$)") {
      return $true
    }
  }

  return $false
}

function Invoke-InstallerWebRequestWithRetry {
  param (
    [Parameter(Mandatory = $true)] [string] $Uri,
    [hashtable] $Headers,
    [string] $OutFile
  )

  $retryDelaysMs = @(250, 1000)
  for ($attempt = 0; $attempt -le $retryDelaysMs.Length; $attempt += 1) {
    try {
      $params = @{ Uri = $Uri }
      if ($Headers) {
        $params.Headers = $Headers
      }
      if ($OutFile) {
        $params.OutFile = $OutFile
      }
      return Invoke-WebRequest @params
    }
    catch {
      if ($attempt -ge $retryDelaysMs.Length -or -not (Test-InstallerTransientWebException -ErrorRecord $_)) {
        throw
      }
      Start-Sleep -Milliseconds $retryDelaysMs[$attempt]
    }
  }
}

function Invoke-InstallerRestMethodWithRetry {
  param (
    [Parameter(Mandatory = $true)] [string] $Uri,
    [hashtable] $Headers
  )

  $retryDelaysMs = @(250, 1000)
  for ($attempt = 0; $attempt -le $retryDelaysMs.Length; $attempt += 1) {
    try {
      $params = @{ Uri = $Uri }
      if ($Headers) {
        $params.Headers = $Headers
      }
      return Invoke-RestMethod @params
    }
    catch {
      if ($attempt -ge $retryDelaysMs.Length -or -not (Test-InstallerTransientWebException -ErrorRecord $_)) {
        throw
      }
      Start-Sleep -Milliseconds $retryDelaysMs[$attempt]
    }
  }
}

function Resolve-MinisignExecutablePath {
  param (
    [string[]] $AdditionalPathEntries = @()
  )

  $command = Get-Command minisign -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $pathEntries = @()
  if ($env:Path) {
    $pathEntries += $env:Path -split ';'
  }
  $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
  if ($userPath) {
    $pathEntries += $userPath -split ';'
  }
  $machinePath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
  if ($machinePath) {
    $pathEntries += $machinePath -split ';'
  }
  if ($env:LOCALAPPDATA) {
    $pathEntries += Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $pathEntries += Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  }
  $pathEntries += $AdditionalPathEntries

  foreach ($pathEntry in $pathEntries) {
    $trimmedEntry = [string]$pathEntry
    if (-not $trimmedEntry) {
      continue
    }

    $candidate = Join-Path $trimmedEntry.Trim() "minisign.exe"
    if (Test-Path $candidate) {
      return $candidate
    }

    if ($trimmedEntry -match '[\\/]WinGet[\\/]Packages$' -and (Test-Path $trimmedEntry)) {
      $nestedCandidate = Get-ChildItem -Path $trimmedEntry.Trim() -Filter "minisign.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($nestedCandidate) {
        return $nestedCandidate.FullName
      }
    }
  }

  return $null
}

function Invoke-NativeCommandCapturingOutput {
  param (
    [Parameter(Mandatory = $true)] [scriptblock] $Command
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $Command 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
      $exitCode = 1
    }
    return @{
      Output = if ($null -eq $output) { "" } else { $output }
      ExitCode = $exitCode
    }
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Ensure-Minisign {
  param (
    [Parameter(Mandatory = $true)] [string] $TempRoot
  )
  $existingMinisign = Resolve-MinisignExecutablePath
  if ($existingMinisign) {
    return $existingMinisign
  }

  # Self-contained fallback: download a known minisign release asset.
  $minisignVersion = "0.12"
  $asset = "minisign-$minisignVersion-win64.zip"
  $expectedSha = "37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479"
  $zipPath = Join-Path $TempRoot $asset
  Invoke-InstallerWebRequestWithRetry -Uri "https://github.com/jedisct1/minisign/releases/download/$minisignVersion/$asset" -OutFile $zipPath
  $actualSha = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha) {
    throw "minisign bootstrap checksum mismatch (expected $expectedSha, got $actualSha)."
  }

  $extractDir = Join-Path $TempRoot "minisign-extract"
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  $exe = Get-ChildItem -Path $extractDir -Filter "minisign.exe" -Recurse | Select-Object -First 1
  if (-not $exe) {
    throw "Failed to locate minisign.exe in bootstrap archive."
  }

  try {
    & $exe.FullName --version *> $null
  }
  catch {
    Write-Warning "Downloaded minisign binary is not compatible with this system. Attempting install via winget..."
    try {
      $wingetInstallResult = Invoke-NativeCommandCapturingOutput {
        winget install --id jedisct1.minisign --accept-source-agreements --accept-package-agreements
      }
      if ($wingetInstallResult.ExitCode -ne 0 -and $wingetInstallResult.Output) {
        Write-Warning $wingetInstallResult.Output.Trim()
      }
      $wingetMinisign = Resolve-MinisignExecutablePath
      if ($wingetMinisign) {
        return $wingetMinisign
      }
      if ($wingetInstallResult.ExitCode -ne 0) {
        throw "winget install failed."
      }
    }
    catch {}
    throw "minisign is not available and could not be installed automatically. Please install minisign manually (for example, 'winget install jedisct1.minisign') and retry."
  }

  return $exe.FullName
}

function Resolve-MinisignPublicKey {
  param (
    [Parameter(Mandatory = $true)] [string] $TargetPath
  )
  if ($MinisignPubKey) {
    Set-Content -Path $TargetPath -Value "$MinisignPubKey`n" -NoNewline
    return
  }
  if (-not $MinisignPubKeyUrl) {
    throw "HAPPIER_MINISIGN_PUBKEY_URL is empty; cannot fetch minisign public key."
  }
  Invoke-InstallerWebRequestWithRetry -Uri $MinisignPubKeyUrl -OutFile $TargetPath
}

$tag = if ($Channel -eq "preview") { "cli-preview" } elseif ($Channel -eq "publicdev") { "cli-dev" } else { "cli-stable" }
if (-not $ReleaseAssetsDir) {
  Write-Host "Fetching $tag release metadata..."
  try {
    $release = Invoke-InstallerRestMethodWithRetry -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $GitHubHeaders
  }
  catch {
    if ($Channel -eq "stable") {
      throw "No stable releases found for Happier CLI."
    }
    if ($Channel -eq "publicdev") {
      throw "No dev releases found for Happier CLI."
    }
    throw "No preview releases found for Happier CLI."
  }
}
else {
  $release = $null
}
$asset = Resolve-InstallerAsset -Release $release -Pattern '^happier-v.*-windows-x64\.tar\.gz$'
$checksumsAsset = Resolve-InstallerAsset -Release $release -Pattern '^checksums-happier-v.*\.txt$'
$signatureAsset = Resolve-InstallerAsset -Release $release -Pattern '^checksums-happier-v.*\.txt\.minisig$'
if (-not $asset) {
  throw "Unable to locate Windows x64 binary on release tag $tag."
}
if (-not $checksumsAsset) {
  throw "Unable to locate checksum asset on release tag $tag."
}
if (-not $signatureAsset) {
  throw "Unable to locate minisign signature asset on release tag $tag."
}

$tmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("happier-install-" + [System.Guid]::NewGuid().ToString("N")))
try {
  $archivePath = Join-Path $tmpDir.FullName "happier.tar.gz"
  $checksumsPath = Join-Path $tmpDir.FullName "checksums.txt"
  $signaturePath = Join-Path $tmpDir.FullName "checksums.txt.minisig"
  $pubKeyPath = Join-Path $tmpDir.FullName "minisign.pub"

  Copy-OrDownloadInstallerAsset -Source $asset.Source -DestinationPath $archivePath
  Copy-OrDownloadInstallerAsset -Source $checksumsAsset.Source -DestinationPath $checksumsPath
  Copy-OrDownloadInstallerAsset -Source $signatureAsset.Source -DestinationPath $signaturePath

  $assetName = [string]$asset.Name
  $expectedSha = $null
  foreach ($line in (Get-Content -Path $checksumsPath)) {
    if ($line -match '^([a-fA-F0-9]{64})\s{2}(.+)$' -and $matches[2] -eq $assetName) {
      $expectedSha = $matches[1].ToLowerInvariant()
      break
    }
  }
  if (-not $expectedSha) {
    throw "Failed to resolve checksum for $assetName"
  }
  $actualSha = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expectedSha -ne $actualSha) {
    throw "Checksum verification failed."
  }
  Write-Host "Checksum verified."

  $minisign = Ensure-Minisign -TempRoot $tmpDir.FullName
  Resolve-MinisignPublicKey -TargetPath $pubKeyPath
  $minisignVerifyResult = Invoke-NativeCommandCapturingOutput {
    & $minisign -Vm $checksumsPath -x $signaturePath -p $pubKeyPath
  }
  if ($minisignVerifyResult.ExitCode -ne 0) {
    if ($minisignVerifyResult.Output) {
      Write-Warning $minisignVerifyResult.Output.Trim()
    }
    throw "Signature verification failed."
  }
  Write-Host "Signature verified."

  $extractDir = Join-Path $tmpDir.FullName "extract"
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  tar -xzf $archivePath -C $extractDir
  $version = $assetName -replace '^happier-v', '' -replace '-windows-x64\.tar\.gz$', ''
  if (-not $version -or $version -eq $assetName) {
    throw "Failed to infer release version from asset name: $assetName"
  }
  $payloadRoot = Join-Path $extractDir "happier-v$version-windows-x64"
  if (-not (Test-Path $payloadRoot)) {
    throw "Failed to locate extracted payload root: $payloadRoot"
  }
  $binary = Join-Path $payloadRoot "happier.exe"
  if (-not (Test-Path $binary)) {
    throw "Failed to locate extracted happier.exe"
  }

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $target = Join-Path $BinDir "$((Resolve-CliShimName)).exe"

  $previousHappyHomeDir = $env:HAPPIER_HOME_DIR
  try {
    $env:HAPPIER_HOME_DIR = $InstallDir
    $promotionResult = Invoke-NativeCommandCapturingOutput {
      & $binary self __install-payload --component happier-cli --payload-root $payloadRoot --version $version --channel $Channel
    }
  }
  finally {
    if ($null -eq $previousHappyHomeDir) {
      Remove-Item Env:HAPPIER_HOME_DIR -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_HOME_DIR = $previousHappyHomeDir
    }
  }
  if ($promotionResult.ExitCode -ne 0) {
    if ($promotionResult.Output -match '(Unknown self subcommand:\s+__install-payload|ENOENT: no such file or directory, open)') {
      Write-Warning "Payload promotion failed, falling back to direct binary copy."
      if ($promotionResult.Output) {
        Write-Warning $promotionResult.Output.Trim()
      }
      Copy-Item -Path $binary -Destination $target -Force
    }
    else {
      if ($promotionResult.Output) {
        Write-Warning $promotionResult.Output.Trim()
      }
      throw "Payload promotion failed."
    }
  }
  if ($LegacyBinDir -ne $BinDir) {
    Remove-Item -Path (Join-Path $LegacyBinDir "happier.exe") -Force -ErrorAction SilentlyContinue
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
  $pathEntries = @()
  if ($userPath) {
    $pathEntries = @(
      $userPath -split ';' |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and $_ -ne $LegacyBinDir -and $_ -ne $BinDir }
    )
  }
  $updatedPathEntries = @($BinDir) + $pathEntries
  [Environment]::SetEnvironmentVariable("Path", ($updatedPathEntries -join ';'), [EnvironmentVariableTarget]::User)
  $env:Path = ($updatedPathEntries -join ';')
  if ($pathEntries.Length -eq 0 -or $userPath -notmatch [Regex]::Escape($BinDir)) {
    Write-Host "Added $BinDir to user PATH."
    Show-PathReloadGuidance -ShimName (Resolve-CliShimName) -BinDir $BinDir
  }

  $invoker = Resolve-InstalledCliInvoker
  if (-not $invoker) {
    $invoker = $target
  }

  Write-Host "Happier CLI installed at $invoker"
  & $invoker --version

  $backgroundServiceInventory = @{
    Supported = $false
    Entries = @()
  }
  $shouldInspectBackgroundServices = $true
  if ($WithDaemonExplicit -and (ConvertTo-InstallerBoolean -Raw ([string]$WithDaemonPreference)) -eq "0") {
    $shouldInspectBackgroundServices = $false
  }
  if ($shouldInspectBackgroundServices) {
    $backgroundServiceInventory = Get-InstalledBackgroundServiceInventory -CliPath $invoker
  }
  if ($shouldInspectBackgroundServices -and $Noninteractive -ne "1") {
    $backgroundServiceReportText = Get-BackgroundServiceReportText -CliPath $invoker
    if (-not [string]::IsNullOrWhiteSpace($backgroundServiceReportText)) {
      Write-Host $backgroundServiceReportText.TrimEnd()
    }
    elseif ($backgroundServiceInventory.Supported -and $backgroundServiceInventory.Entries.Count -gt 0) {
      Show-InstalledBackgroundServiceSummary -CliPath $invoker -Entries $backgroundServiceInventory.Entries -Inventory $backgroundServiceInventory
      Show-InstalledLocalRelaySummary -Relays $backgroundServiceInventory.Relays
    }
  }

  $resolvedWithDaemon = Resolve-WithDaemonPreference -Entries $backgroundServiceInventory.Entries
  if ($resolvedWithDaemon -ne "0") {
    if ($backgroundServiceInventory.Supported) {
      $installStrategy = Resolve-ExistingBackgroundServiceInstallStrategy -Entries $backgroundServiceInventory.Entries
      $installCommand = Get-BackgroundServiceInstallManualCommand -CliPath $invoker
      if ($installStrategy -eq "replace-all") {
        $repairResult = Invoke-DoctorRepairIfSupported -CliPath $invoker
        if ($repairResult.Status -eq 'applied') {
          Write-Host "Updating automatic startup to this release channel..."
        }
        elseif ($repairResult.Status -eq 'unsupported') {
          Write-Host "Setting up automatic startup (user-mode)..."
          $installResult = Invoke-BackgroundServiceInstallCompatibly -CliPath $invoker
          if (-not $installResult.Ok) {
            Write-Warning "background service install failed. You can retry manually: `"$installCommand`""
          }
        }
        else {
          if ($backgroundServiceInventory.RepairSupported -and @($backgroundServiceInventory.Entries | Where-Object { $_.mode -eq 'system' }).Count -gt 0) {
            Write-Warning "system background services require sudo to repair or switch. Retry manually with elevated privileges: `"$invoker doctor repair --yes`""
          }
          else {
            Write-Warning "background service install failed. You can retry manually: `"$invoker doctor repair --yes`""
          }
        }
      }
      elseif ($installStrategy -eq "add") {
        Write-Host "Setting up automatic startup (additional service, user-mode)..."
        $installResult = Invoke-BackgroundServiceInstallCompatibly -CliPath $invoker
        if (-not $installResult.Ok) {
          Write-Warning "background service install failed. You can retry manually: `"$installCommand`""
        }
      }
      elseif ($installStrategy -eq "skip") {
        Write-Host "Keeping existing background services unchanged."
      }
      else {
        $skipBackgroundServiceInstall = $false
        if ($Noninteractive -eq "1") {
          $repairResult = Invoke-DoctorRepairIfSupported -CliPath $invoker
          if ($repairResult.Status -eq 'applied') {
            Write-Host "Repairing automatic startup (best-effort)..."
          }
          elseif ($repairResult.Status -eq 'failed') {
            if ($backgroundServiceInventory.RepairSupported -and @($backgroundServiceInventory.Entries | Where-Object { $_.mode -eq 'system' }).Count -gt 0) {
              Write-Warning "system background services require sudo to repair or switch. Retry manually with elevated privileges: `"$invoker doctor repair --yes`""
              $skipBackgroundServiceInstall = $true
            }
            else {
              Write-Host "Repairing automatic startup (best-effort)..."
              Write-Warning "background service repair failed. You can retry manually: `"$invoker doctor repair --yes`""
              $skipBackgroundServiceInstall = $true
            }
          }
        }
        if (-not $skipBackgroundServiceInstall) {
          Write-Host "Setting up automatic startup (user-mode)..."
          $installResult = Invoke-BackgroundServiceInstallCompatibly -CliPath $invoker
          if (-not $installResult.Ok) {
            Write-Warning "background service install failed. You can retry manually: `"$installCommand`""
          }
        }
      }
    }
  }

  Invoke-PostInstallAction -CliPath $invoker
}
finally {
  Remove-Item -Path $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
