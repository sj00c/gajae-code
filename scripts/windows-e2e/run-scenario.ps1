# Windows E2E scenario runner (observation only).
#
# Executes exactly one (scenario, attempt) on a fresh GitHub-hosted VM and
# writes an observation JSON to $env:RUNNER_TEMP\e2e-out. It never decides
# green/red: scripts/windows-e2e/classify.ts applies oracles.v1.json to the
# observation. Harness-side failures are recorded as `harness_error` so they
# can never be mistaken for product behavior.
#
# Refuses to run outside GitHub Actions: it installs gjc, edits HKCU Path and
# kills processes, which must never happen on a developer machine.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne "true") {
    Write-Error "run-scenario.ps1 only runs on GitHub Actions runners (GITHUB_ACTIONS != true)."
    exit 2
}

$Repo = "Yeachan-Heo/gajae-code"
$Scenario = $env:E2E_SCENARIO
$ShellName = $env:E2E_SHELL
$Attempt = [int]$env:E2E_ATTEMPT
# Only logs go to RUNNER_TEMP. Everything gjc touches uses the documented
# defaults (%LOCALAPPDATA%\gjc, %USERPROFILE%\.gjc\agent) on the profile
# volume: RUNNER_TEMP lives on D: whose inherited ACL (Authenticated Users)
# is a runner-specific condition, not something a user install sees. Each
# matrix job is a fresh VM, so the defaults are already isolated.
$OutDir = Join-Path $env:RUNNER_TEMP "e2e-out"
$Work = Join-Path $env:USERPROFILE "e2e-work"
$InstallDir = Join-Path $env:LOCALAPPDATA "gjc"
$AgentDir = Join-Path $env:USERPROFILE ".gjc\agent"
$GjcExe = Join-Path $InstallDir "gjc.exe"
New-Item -ItemType Directory -Force -Path $OutDir, $Work | Out-Null
Remove-Item Env:GJC_INSTALL_DIR -ErrorAction SilentlyContinue
Remove-Item Env:GJC_CODING_AGENT_DIR -ErrorAction SilentlyContinue
$env:GITHUB_TOKEN = $env:GH_TOKEN
# Plain error text: pwsh 7 honors NO_COLOR, so installer errors are not
# split by ANSI sequences.
$env:NO_COLOR = "1"

$Obs = [ordered]@{
    schema = "gjc.windows-e2e.observation.v1"
    scenario = $Scenario
    shell = $ShellName
    attempt = $Attempt
    dispatch_run_id = $env:E2E_RUN_ID
    base_sha = $env:E2E_BUILD_REF
    installer_rev = $null
    updater_build = $null
    post_activation_build = $null
    prev_tag = $env:E2E_PREV_TAG
    target_tag = $null
    expected_version = $null
    binaries = New-Object System.Collections.ArrayList
    env = [ordered]@{}
    steps = New-Object System.Collections.ArrayList
    marker = $null
    post_kill_record_phase = $null
    lock_observed = $null
    lock_observations = New-Object System.Collections.ArrayList
    snapshots = [ordered]@{}
    final = $null
    unbuildable = $null
    harness_error = $null
}

function Save-Observation {
    $path = Join-Path $OutDir ("{0}-{1}-{2}.json" -f $Scenario, $ShellName, $Attempt)
    $Obs | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -Path $path
    Write-Host "observation: $path"
}

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Add-Binary([string]$Role, [string]$Build, [string]$Path) {
    [void]$Obs.binaries.Add([ordered]@{ role = $Role; build = $Build; sha256 = (Get-Sha256 $Path) })
}

function Get-Tail([string]$Text, [int]$Max = 4000) {
    if ($null -eq $Text) { return "" }
    if ($Text.Length -le $Max) { return $Text }
    return $Text.Substring($Text.Length - $Max)
}

function Invoke-GithubApi([string]$Path) {
    $headers = @{ "User-Agent" = "gjc-windows-e2e"; "Accept" = "application/vnd.github+json"; "Authorization" = "Bearer $env:GH_TOKEN" }
    return Invoke-RestMethod -Uri "https://api.github.com$Path" -Headers $headers
}

function Start-Logged([string]$Name, [string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Work) {
    $stdout = Join-Path $OutDir "$Name.stdout.txt"
    $stderr = Join-Path $OutDir "$Name.stderr.txt"
    $quoted = $Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $p = Start-Process -FilePath $File -ArgumentList $quoted -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    return [pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr; Started = Get-Date }
}

function Complete-Logged($Handle, [int]$TimeoutSec, [string]$Kind = "step") {
    $timedOut = -not $Handle.Process.WaitForExit($TimeoutSec * 1000)
    if ($timedOut) { & taskkill.exe /T /F /PID $Handle.Process.Id 2>&1 | Out-Null; $Handle.Process.WaitForExit(10000) | Out-Null }
    $Handle.Process.WaitForExit()
    $record = [ordered]@{
        name = $Handle.Name
        kind = $Kind
        exit_code = if ($timedOut) { $null } else { $Handle.Process.ExitCode }
        timed_out = $timedOut
        killed = $false
        duration_ms = [int]((Get-Date) - $Handle.Started).TotalMilliseconds
        stdout_tail = Get-Tail (Get-Content -Raw -ErrorAction SilentlyContinue $Handle.Stdout)
        stderr_tail = Get-Tail (Get-Content -Raw -ErrorAction SilentlyContinue $Handle.Stderr)
        gjc_sha256_after = Get-Sha256 $GjcExe
    }
    [void]$Obs.steps.Add($record)
    return $record
}

function Invoke-Logged([string]$Name, [string]$File, [string[]]$Arguments, [int]$TimeoutSec = 600, [string]$Kind = "step", [string]$WorkingDirectory = $Work) {
    $before = Get-Sha256 $GjcExe
    $h = Start-Logged $Name $File $Arguments $WorkingDirectory
    $r = Complete-Logged $h $TimeoutSec $Kind
    $r["gjc_sha256_before"] = $before
    return $r
}

function Get-InstallerPath {
    if ($env:E2E_INSTALLER -eq "checkout") {
        $path = Join-Path $env:GITHUB_WORKSPACE "product\scripts\install.ps1"
        $Obs.installer_rev = [ordered]@{ source = "checkout:$($env:E2E_BUILD_REF)"; sha256 = (Get-Sha256 $path) }
        return $path
    }
    $path = Join-Path $Work "install.ps1"
    $url = "https://raw.githubusercontent.com/$Repo/$($env:E2E_INSTALLER_REV)/scripts/install.ps1"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path
    $sha = Get-Sha256 $path
    $Obs.installer_rev = [ordered]@{ source = "main:$($env:E2E_INSTALLER_REV)"; sha256 = $sha }
    if ($sha -ne $env:E2E_INSTALLER_SHA256.ToLowerInvariant()) {
        throw "installer sha256 mismatch: expected $($env:E2E_INSTALLER_SHA256) got $sha"
    }
    return $path
}

function Get-ShellExe([string]$Name) {
    if ($Name -eq "powershell") { return (Get-Command powershell.exe).Source }
    return (Get-Command pwsh.exe).Source
}

# A powershell.exe child started from pwsh inherits pwsh 7's PSModulePath and
# then cannot autoload its own core modules (Get-FileHash is "not recognized").
# Users start the installer from a fresh Windows PowerShell, so give the child
# the machine/user module path it would have there.
function Use-ShellModulePath([scriptblock]$Body) {
    if ($ShellName -ne "powershell") { return & $Body }
    $saved = $env:PSModulePath
    $parts = @(
        [Environment]::GetEnvironmentVariable("PSModulePath", "User"),
        [Environment]::GetEnvironmentVariable("PSModulePath", "Machine")
    ) | Where-Object { $_ }
    $env:PSModulePath = ($parts -join ";")
    try { return & $Body } finally { $env:PSModulePath = $saved }
}

function Invoke-Installer([string]$Name, [string]$Tag, [int]$TimeoutSec = 600) {
    return Use-ShellModulePath { Invoke-Logged $Name (Get-ShellExe $ShellName) @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script:Installer, "-Binary", "-Ref", $Tag) $TimeoutSec "installer" }
}

function Start-Installer([string]$Name, [string]$Tag) {
    return Use-ShellModulePath { Start-Logged $Name (Get-ShellExe $ShellName) @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script:Installer, "-Binary", "-Ref", $Tag) }
}

function Get-GjcVersion {
    if (-not (Test-Path -LiteralPath $GjcExe)) { return $null }
    $out = & $GjcExe --version 2>&1 | Out-String
    if ($out -match '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)') { return $Matches[1] }
    return $null
}

function Compare-Semver([string]$A, [string]$B) {
    # Returns -1/0/1. Prerelease sorts below its release (semver 2.0).
    $pa = $A -split '-', 2; $pb = $B -split '-', 2
    $va = [version]$pa[0]; $vb = [version]$pb[0]
    $c = $va.CompareTo($vb)
    if ($c -ne 0) { return [Math]::Sign($c) }
    if ($pa.Count -eq 1 -and $pb.Count -eq 1) { return 0 }
    if ($pa.Count -eq 1) { return 1 }
    if ($pb.Count -eq 1) { return -1 }
    return [Math]::Sign([string]::CompareOrdinal($pa[1], $pb[1]))
}

function Get-ActivationRecordPath { return "$GjcExe.activation.v1.json" }

function Read-ActivationPhase {
    $p = Get-ActivationRecordPath
    if (-not (Test-Path -LiteralPath $p)) { return "none" }
    try { return [string]((Get-Content -Raw -LiteralPath $p | ConvertFrom-Json).phase) } catch { return "unreadable" }
}

function Get-DirSnapshot([string]$Dir) {
    # Leading comma: a one-entry directory must still serialize as a JSON array.
    if (-not (Test-Path -LiteralPath $Dir)) { return ,@() }
    return ,@(Get-ChildItem -Force -LiteralPath $Dir | ForEach-Object {
        [ordered]@{ name = $_.Name; dir = $_.PSIsContainer; length = if ($_.PSIsContainer) { $null } else { $_.Length } }
    })
}

function Get-StateSnapshot {
    return [ordered]@{
        hkcu_path = [Environment]::GetEnvironmentVariable("Path", "User")
        install_dir = Get-DirSnapshot $InstallDir
        agent_sdk = Get-DirSnapshot (Join-Path $AgentDir "sdk")
        activation_phase = Read-ActivationPhase
        user_gjc_present = Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".gjc")
        localappdata_gjc_present = Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "gjc")
    }
}

function Get-FinalState {
    $crash = @(Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $AgentDir -Filter "gjc-crash*.log")
    return [ordered]@{
        version = Get-GjcVersion
        gjc_sha256 = Get-Sha256 $GjcExe
        install_dir = Get-DirSnapshot $InstallDir
        activation_phase = Read-ActivationPhase
        crash_logs = @($crash | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($AgentDir.Length); tail = Get-Tail (Get-Content -Raw $_.FullName) 2000 } })
    }
}

# Polls `Condition` every 10 ms; returns $true when it holds before the
# process exits or the deadline passes.
function Wait-Marker([scriptblock]$Condition, $Handle, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        if ($Handle.Process.HasExited) { return [bool](& $Condition) }
        Start-Sleep -Milliseconds 10
    }
    return $false
}

function Stop-Tree($Handle) {
    & taskkill.exe /T /F /PID $Handle.Process.Id 2>&1 | Out-Null
    $Handle.Process.WaitForExit(15000) | Out-Null
}

function Resolve-Tags {
    $Obs.env = [ordered]@{
        runner_image = "$($env:ImageOS) $($env:ImageVersion)"
        os_build = [Environment]::OSVersion.VersionString
        gh_token_present = [bool]$env:GH_TOKEN
        ratelimit_remaining = $null
    }
    try { $Obs.env.ratelimit_remaining = (Invoke-GithubApi "/rate_limit").resources.core.remaining } catch {}
    if ($env:E2E_TARGET -eq "nightly") {
        $rel = @(Invoke-GithubApi "/repos/$Repo/releases?per_page=30") | ForEach-Object { $_ } | Where-Object { $_.prerelease -and -not $_.draft } | Select-Object -First 1
    } else {
        $rel = Invoke-GithubApi "/repos/$Repo/releases/latest"
    }
    $Obs.target_tag = $rel.tag_name
    $Obs.expected_version = $rel.tag_name.TrimStart("v")
    $Obs.post_activation_build = "pub:$($rel.tag_name)"
}

# Installs prev_tag with the pinned installer and, for updater=fork, places
# the fork build over gjc.exe by copy (recorded as `copy-placed`).
function Initialize-Executor([string]$StepName = "install-prev", [bool]$FailureIsProductOutcome = $false) {
    $r = Invoke-Installer $StepName $env:E2E_PREV_TAG
    if ($r.exit_code -ne 0) {
        # A failed reinstall after an interrupted update is the documented
        # recovery failing: the oracle judges it. Only the first install is a
        # precondition.
        if ($FailureIsProductOutcome) { return $false }
        throw "precondition: installing $($env:E2E_PREV_TAG) failed (exit $($r.exit_code))"
    }
    Add-Binary "installed" "pub:$($env:E2E_PREV_TAG)" $GjcExe
    if ($env:E2E_UPDATER -eq "fork") {
        $fork = Join-Path $env:RUNNER_TEMP "fork\gjc-windows-x64.exe"
        if (-not (Test-Path -LiteralPath $fork)) { throw "updater=fork but no fork build was downloaded" }
        Copy-Item -LiteralPath $fork -Destination $GjcExe -Force
        Add-Binary "copy-placed" "fork:$($env:E2E_BUILD_REF)" $GjcExe
        $Obs.updater_build = "fork:$($env:E2E_BUILD_REF)"
    } else {
        $pubTag = if ($env:E2E_UPDATER -match '^pub:(.+)$') { $Matches[1] } else { $env:E2E_PREV_TAG }
        if ($pubTag -ne "latest" -and $pubTag -ne $env:E2E_PREV_TAG) { throw "updater=pub:$pubTag must equal prev_tag $($env:E2E_PREV_TAG)" }
        $Obs.updater_build = "pub:$($env:E2E_PREV_TAG)"
    }
    Add-Binary "updater" $Obs.updater_build $GjcExe
    return $true
}

function Get-UpdateArgs {
    $cmd = @("update")
    if ($env:E2E_TARGET -eq "nightly") { $cmd += @("--channel", "nightly") }
    $installed = Get-GjcVersion
    if ($installed -and (Compare-Semver $installed $Obs.expected_version) -ge 0) { $cmd += "--force" }
    return ,$cmd
}

function Start-UpdateUntilRecord([string]$Name) {
    $h = Start-Logged $Name $GjcExe (Get-UpdateArgs)
    $recordPath = Get-ActivationRecordPath
    $seen = Wait-Marker { Test-Path -LiteralPath $recordPath } $h 300
    $Obs.marker = [ordered]@{ name = "activation-record-created"; observed = $seen; process_exited_first = $h.Process.HasExited }
    if (-not $h.Process.HasExited) { Stop-Tree $h }
    $r = Complete-Logged $h 30 "update"
    $r.killed = $seen
    $Obs.post_kill_record_phase = Read-ActivationPhase
    Add-Binary "post-kill" "unknown" $GjcExe
}

function Finish-Update([string]$Name) {
    $r = Invoke-Logged $Name $GjcExe (Get-UpdateArgs) 900 "update"
    Add-Binary "post-activation" $Obs.post_activation_build $GjcExe
    return $r
}

# Starts N copies of a gjc command at once and records each as a step. While
# they run, polls for lock directories under `$WatchDir` (evidence that the
# driver really reaches the lock under test).
function Invoke-Concurrent([string]$Prefix, [int]$Count, [string[]]$Arguments, [string]$WatchDir, [string]$WorkingDirectory = $Work) {
    $handles = @()
    for ($i = 1; $i -le $Count; $i++) { $handles += Start-Logged ("{0}-{1}" -f $Prefix, $i) $GjcExe $Arguments $WorkingDirectory }
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $deadline = (Get-Date).AddSeconds(240)
    while ((Get-Date) -lt $deadline -and @($handles | Where-Object { -not $_.Process.HasExited }).Count -gt 0) {
        # Lock directories appear and vanish while being enumerated; a race
        # here is expected and must not abort the scenario.
        try {
            if (Test-Path -LiteralPath $WatchDir) {
                Get-ChildItem -Recurse -Directory -Force -ErrorAction SilentlyContinue -LiteralPath $WatchDir -Filter "*.lock" | ForEach-Object { [void]$seen.Add($_.FullName.Substring($WatchDir.Length)) }
            }
        } catch {}
        Start-Sleep -Milliseconds 5
    }
    foreach ($h in $handles) { [void](Complete-Logged $h 30 "lock-driver") }
    foreach ($s in $seen) { if (-not $Obs.lock_observations.Contains($s)) { [void]$Obs.lock_observations.Add($s) } }
    if ($seen.Count -gt 0) { $Obs.lock_observed = $true } elseif ($null -eq $Obs.lock_observed) { $Obs.lock_observed = $false }
}

function Initialize-CurrentGjc {
    # Lock scenarios run the executor under test directly (no update).
    [void](Initialize-Executor)
}

$script:Installer = $null
try {
    Resolve-Tags
    $script:Installer = Get-InstallerPath
    $Obs.snapshots.before = Get-StateSnapshot

    switch ($Scenario) {
        "U1" {
            [void](Initialize-Executor)
            [void](Finish-Update "update")
        }
        "U2" {
            [void](Initialize-Executor)
            Start-UpdateUntilRecord "update-killed"
            if (Initialize-Executor "reinstall-prev" $true) { [void](Finish-Update "update") }
        }
        "U3" {
            [void](Initialize-Executor)
            $holder = Start-Logged "holder-broker" $GjcExe @("sdk", "broker", "run")
            Start-Sleep -Seconds 5
            if ($holder.Process.HasExited) {
                [void](Complete-Logged $holder 5 "holder")
                $Obs.unbuildable = "holder process 'gjc sdk broker run' exited before update; no credential-free long-running gjc process"
            } else {
                $Obs.marker = [ordered]@{ name = "holder-running"; observed = $true; pid = $holder.Process.Id }
                [void](Finish-Update "update")
                Stop-Tree $holder
                [void](Complete-Logged $holder 15 "holder")
            }
        }
        "U4" {
            [void](Initialize-Executor)
            Start-UpdateUntilRecord "update-killed"
            [void](Finish-Update "update")
        }
        "L1" {
            Initialize-CurrentGjc
            for ($round = 1; $round -le 20; $round++) {
                Invoke-Concurrent ("config-set-r{0}" -f $round) 10 @("config", "set", "telemetry.enabled", ($round % 2 -eq 0).ToString().ToLowerInvariant()) $AgentDir
            }
        }
        "L2" {
            Initialize-CurrentGjc
            $proj = Join-Path $Work "project"
            New-Item -ItemType Directory -Force -Path $proj | Out-Null
            & git -C $proj init -q 2>&1 | Out-Null
            $env:GJC_SESSION_ID = "e2e-l2-session"
            for ($round = 1; $round -le 20; $round++) {
                Invoke-Concurrent ("state-write-r{0}" -f $round) 10 @("state", "ralplan", "write", "--input", ('{"current_phase":"planner","e2e_round":' + $round + '}'), "--json") (Join-Path $proj ".gjc") $proj
            }
            $stateFiles = @(Get-ChildItem -Recurse -File -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $proj ".gjc") -Filter "ralplan-state.json")
            $Obs["state_files"] = @($stateFiles | ForEach-Object {
                $ok = $true; try { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null } catch { $ok = $false }
                [ordered]@{ path = $_.FullName.Substring($proj.Length); parses = $ok }
            })
        }
        "L3" {
            # The legacy host-unqualified broker.lock must come from a real
            # pre-#6720 binary (v0.18.11), never a hand-written file.
            $legacyDir = Join-Path $env:LOCALAPPDATA "gjc-legacy"
            $env:GJC_INSTALL_DIR = $legacyDir
            try { $r = Invoke-Installer "install-legacy" "v0.18.11" } finally { Remove-Item Env:GJC_INSTALL_DIR -ErrorAction SilentlyContinue }
            if ($r.exit_code -ne 0) { throw "precondition: installing legacy v0.18.11 failed" }
            $legacyExe = Join-Path $legacyDir "gjc.exe"
            Add-Binary "legacy" "pub:v0.18.11" $legacyExe
            $legacyBroker = Start-Logged "legacy-broker" $legacyExe @("sdk", "broker", "run")
            $lockDir = Join-Path $AgentDir "sdk\broker.lock"
            $seen = Wait-Marker { Test-Path -LiteralPath (Join-Path $lockDir "owner.json") } $legacyBroker 60
            $Obs.marker = [ordered]@{ name = "legacy-broker-lock-created"; observed = $seen }
            if (-not $seen) { throw "precondition: legacy broker never created sdk/broker.lock/owner.json" }
            $Obs["legacy_owner"] = Get-Content -Raw (Join-Path $lockDir "owner.json")
            Initialize-CurrentGjc
            # `sdk session list` scopes to a Git repository.
            $proj = Join-Path $Work "project"
            New-Item -ItemType Directory -Force -Path $proj | Out-Null
            & git -C $proj init -q 2>&1 | Out-Null
            # Case a: legacy broker still alive (upgrade while it runs).
            [void](Invoke-Logged "sdk-list-legacy-alive" $GjcExe @("sdk", "session", "list", "--json") 180 "lock-driver" $proj)
            # Case b: legacy broker killed, its lock left behind.
            Stop-Tree $legacyBroker
            [void](Complete-Logged $legacyBroker 15 "holder")
            [void](Invoke-Logged "sdk-list-legacy-dead" $GjcExe @("sdk", "session", "list", "--json") 180 "lock-driver" $proj)
            $Obs.lock_observed = $true
            [void]$Obs.lock_observations.Add("\sdk\broker.lock")
        }
        "L4" {
            Initialize-CurrentGjc
            for ($round = 1; $round -le 10; $round++) {
                $gc = Start-Logged ("gc-r{0}" -f $round) $GjcExe @("gc", "--prune", "--json")
                Invoke-Concurrent ("config-set-r{0}" -f $round) 10 @("config", "set", "telemetry.enabled", ($round % 2 -eq 0).ToString().ToLowerInvariant()) $AgentDir
                [void](Complete-Logged $gc 120 "lock-driver")
            }
        }
        "I1" {
            $h = Start-Installer "installer-killed" $env:E2E_PREV_TAG
            $seen = Wait-Marker { @(Get-ChildItem -Force -ErrorAction SilentlyContinue -LiteralPath $InstallDir -Filter ".gjc.download.*").Count -gt 0 } $h 300
            $Obs.marker = [ordered]@{ name = "download-temp-created"; observed = $seen; process_exited_first = $h.Process.HasExited }
            if (-not $h.Process.HasExited) { Stop-Tree $h }
            $r = Complete-Logged $h 30 "installer"
            $r.killed = $seen
            $Obs.snapshots.after_kill = Get-StateSnapshot
            [void](Invoke-Installer "installer-rerun" $env:E2E_PREV_TAG)
            $Obs.expected_version = $env:E2E_PREV_TAG.TrimStart("v")
            $Obs.post_activation_build = "pub:$($env:E2E_PREV_TAG)"
        }
        "I2" {
            $r = Invoke-Installer "install-prev" $env:E2E_PREV_TAG
            if ($r.exit_code -ne 0) { throw "precondition: installing $($env:E2E_PREV_TAG) failed" }
            Add-Binary "installed" "pub:$($env:E2E_PREV_TAG)" $GjcExe
            $holder = Start-Logged "holder-broker" $GjcExe @("sdk", "broker", "run")
            Start-Sleep -Seconds 5
            if ($holder.Process.HasExited) {
                [void](Complete-Logged $holder 5 "holder")
                $Obs.unbuildable = "holder process 'gjc sdk broker run' exited before reinstall"
            } else {
                $Obs.marker = [ordered]@{ name = "holder-running"; observed = $true; pid = $holder.Process.Id }
                [void](Invoke-Installer "install-target" $Obs.target_tag)
                Stop-Tree $holder
                [void](Complete-Logged $holder 15 "holder")
                Add-Binary "target" $Obs.post_activation_build $GjcExe
            }
        }
        "I3" {
            $a = Start-Installer "installer-a" $env:E2E_PREV_TAG
            $b = Start-Installer "installer-b" $env:E2E_PREV_TAG
            [void](Complete-Logged $a 600 "installer")
            [void](Complete-Logged $b 600 "installer")
            $Obs.expected_version = $env:E2E_PREV_TAG.TrimStart("v")
            $Obs.post_activation_build = "pub:$($env:E2E_PREV_TAG)"
        }
        default { throw "unknown scenario $Scenario" }
    }
} catch {
    $Obs.harness_error = "$($_.Exception.Message) @ $($_.InvocationInfo.ScriptLineNumber)"
} finally {
    try { $Obs.snapshots.after = Get-StateSnapshot } catch {}
    try { $Obs.final = Get-FinalState } catch { if (-not $Obs.harness_error) { $Obs.harness_error = "final-state: $($_.Exception.Message)" } }
    Save-Observation
}
exit 0
