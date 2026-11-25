param(
    [string]$OmpPath = 'omp',
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

function Resolve-OmpExecutable {
    param([Parameter(Mandatory)][string]$Candidate)
    if (Test-Path -LiteralPath $Candidate) {
        return (Resolve-Path -LiteralPath $Candidate).Path
    }
    $cmd = Get-Command -Name $Candidate -CommandType Application -ErrorAction Stop | Select-Object -First 1
    return $cmd.Source
}

function Test-UnconfiguredRpcFailsFast {
    param(
        [Parameter(Mandatory)][string]$ResolvedOmpPath,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('omp-rpc-unconfigured-' + [System.Guid]::NewGuid().ToString('N'))
    $probeCwd = Join-Path $tempRoot 'cwd'
    $probeAgentDir = Join-Path $tempRoot 'agent'
    New-Item -ItemType Directory -Path $probeCwd, $probeAgentDir -Force | Out-Null

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ResolvedOmpPath
    $psi.Arguments = '--mode rpc --no-session --approval-mode always-ask'
    $psi.WorkingDirectory = $probeCwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.EnvironmentVariables['PI_CODING_AGENT_DIR'] = $probeAgentDir
    $psi.EnvironmentVariables.Remove('OMP_PROFILE')
    $psi.EnvironmentVariables.Remove('PI_PROFILE')
    foreach ($key in 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY') {
        $psi.EnvironmentVariables.Remove($key)
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    try {
        if (-not $process.Start()) {
            throw "Failed to start $ResolvedOmpPath for unconfigured startup probe."
        }
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            throw 'Timed out waiting for unconfigured OMP RPC process to exit.'
        }
        $stderr = $stderrTask.Result
        $stdout = $stdoutTask.Result
        if ($process.ExitCode -eq 0 -or $stderr -notmatch 'No default model selected') {
            throw "Expected non-zero exit with 'No default model selected' when unconfigured, got exitCode=$($process.ExitCode), stdout=$stdout, stderr=$stderr"
        }
        Write-Output "[unconfigured] verified pre-ready fail-fast: exitCode=$($process.ExitCode) (No default model selected)"
    } finally {
        if (-not $process.HasExited) {
            try { $process.Kill() } catch {}
        }
        $process.Dispose()
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-OmpRpcProbe {
    param(
        [Parameter(Mandatory)][string]$ResolvedOmpPath,
        [Parameter(Mandatory)][ValidateSet('rpc', 'rpc-ui')][string]$Mode,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [switch]$IncludeRecoveryChecks,
        [switch]$UseSessionDirContinue
    )

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('omp-rpc-probe-' + [System.Guid]::NewGuid().ToString('N'))
    $probeCwd = Join-Path $tempRoot 'cwd'
    $probeAgentDir = Join-Path $tempRoot 'agent'
    $probeSessionDir = Join-Path $tempRoot 'session'
    New-Item -ItemType Directory -Path $probeCwd, $probeAgentDir, $probeSessionDir -Force | Out-Null

    # OMP v19.1.1 requires a selectable model to enter non-interactive RPC mode.
    # Use an isolated offline dummy provider (auth: none, unreachable loopback port 1); no prompt is ever sent.
    $offlineModelsYaml = @"
providers:
  offline-probe:
    baseUrl: http://127.0.0.1:1/v1
    api: openai-completions
    auth: none
    models:
      - id: offline-probe-model
        name: Offline Probe Model
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 4096
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $probeAgentDir 'models.yml'),
        $offlineModelsYaml,
        (New-Object System.Text.UTF8Encoding($false))
    )

    $sessionArgs = if ($UseSessionDirContinue) {
        "--session-dir `"$probeSessionDir`" --continue"
    } else {
        '--no-session'
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ResolvedOmpPath
    $psi.Arguments = "--mode $Mode $sessionArgs --approval-mode always-ask --model offline-probe/offline-probe-model"
    $psi.WorkingDirectory = $probeCwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.EnvironmentVariables['PI_CODING_AGENT_DIR'] = $probeAgentDir
    $psi.EnvironmentVariables.Remove('OMP_PROFILE')
    $psi.EnvironmentVariables.Remove('PI_PROFILE')

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $stdinWriter = $null

    try {
        if (-not $process.Start()) {
            throw "Failed to start $ResolvedOmpPath in --mode $Mode."
        }

        $stderrTask = $process.StandardError.ReadToEndAsync()
        $stdinWriter = New-Object System.IO.StreamWriter(
            $process.StandardInput.BaseStream,
            (New-Object System.Text.UTF8Encoding($false))
        )
        $stdinWriter.NewLine = "`n"
        $stdinWriter.AutoFlush = $true

        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

        $readNextFrame = {
            while ($true) {
                $remainingMs = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
                if ($remainingMs -le 0) {
                    throw "Timed out waiting for OMP RPC stdout frame in --mode $Mode."
                }
                $lineTask = $process.StandardOutput.ReadLineAsync()
                if (-not $lineTask.Wait($remainingMs)) {
                    throw "Timed out reading OMP RPC stdout line in --mode $Mode."
                }
                $line = $lineTask.Result
                if ($null -eq $line) {
                    $errText = if ($stderrTask.Wait(1000)) { $stderrTask.Result } else { '' }
                    throw "OMP RPC stdout reached unexpected EOF in --mode $Mode. Stderr: $errText"
                }
                if ([string]::IsNullOrWhiteSpace($line)) {
                    continue
                }
                return ($line | ConvertFrom-Json)
            }
        }

        $readUntil = {
            param([scriptblock]$Predicate)
            while ($true) {
                $frame = & $readNextFrame
                if (& $Predicate $frame) {
                    return $frame
                }
            }
        }

        # 1. Verify initial protocol v1 ready frame advertising v2 support and limits
        $ready = & $readUntil { param($f) $f.type -eq 'ready' }
        if ($ready.protocolVersion -ne 1) {
            throw "Expected initial protocolVersion 1 in --mode $Mode, got $($ready.protocolVersion)."
        }
        if ($ready.supportedProtocolVersions -notcontains 2) {
            throw "Expected supportedProtocolVersions to include 2 in --mode $Mode."
        }
        if ($ready.maxFrameBytes -le 0 -or $ready.maxReassembledFrameBytes -le 0) {
            throw "Expected positive frame byte limits in --mode $Mode."
        }
        Write-Output "[$Mode] ready: protocolVersion=$($ready.protocolVersion), supported=[$($ready.supportedProtocolVersions -join ',')], maxFrameBytes=$($ready.maxFrameBytes), maxReassembledFrameBytes=$($ready.maxReassembledFrameBytes)"

        # 2. Negotiate lossless protocol v2 framing
        $stdinWriter.WriteLine('{"id":"p1","type":"negotiate_protocol","protocolVersion":2}')
        $neg = & $readUntil { param($f) $f.type -eq 'response' -and $f.id -eq 'p1' }
        if (-not $neg.success -or $neg.command -ne 'negotiate_protocol' -or $neg.data.protocolVersion -ne 2) {
            throw "Protocol v2 negotiation failed in --mode $Mode."
        }
        Write-Output "[$Mode] negotiate_protocol: protocolVersion=$($neg.data.protocolVersion)"

        # 3. Verify idle session state (zero prompts sent)
        $stdinWriter.WriteLine('{"id":"p2","type":"get_state"}')
        $state = & $readUntil { param($f) $f.type -eq 'response' -and $f.id -eq 'p2' }
        if (-not $state.success -or $state.command -ne 'get_state' -or $state.data.isStreaming -ne $false) {
            throw "get_state failed or reported unexpected streaming state in --mode $Mode."
        }
        Write-Output "[$Mode] get_state: isStreaming=$($state.data.isStreaming), messageCount=$($state.data.messageCount), isSettled=$($state.data.isSettled)"

        if ($IncludeRecoveryChecks) {
            # 4. Verify command discovery surface
            $stdinWriter.WriteLine('{"id":"p3","type":"get_available_commands"}')
            $cmds = & $readUntil { param($f) $f.type -eq 'response' -and $f.id -eq 'p3' }
            if (-not $cmds.success -or $cmds.command -ne 'get_available_commands' -or $null -eq $cmds.data.commands) {
                throw "get_available_commands failed in --mode $Mode."
            }
            $cmdCount = @($cmds.data.commands).Count
            Write-Output "[$Mode] get_available_commands: count=$cmdCount"

            # 5. Verify paginated history endpoint on empty session
            $stdinWriter.WriteLine('{"id":"p4","type":"get_messages_page","limit":10}')
            $page = & $readUntil { param($f) $f.type -eq 'response' -and $f.id -eq 'p4' }
            if (-not $page.success -or $page.command -ne 'get_messages_page' -or $page.data.totalMessages -ne 0) {
                throw "get_messages_page failed in --mode $Mode."
            }
            Write-Output "[$Mode] get_messages_page: totalMessages=$($page.data.totalMessages)"

            # 6. Verify malformed JSON produces recoverable parse error
            $stdinWriter.WriteLine('{not-valid-json')
            $parseErr = & $readUntil { param($f) $f.type -eq 'response' -and $f.command -eq 'parse' }
            if ($parseErr.success -ne $false) {
                throw "Expected success=false for malformed JSON in --mode $Mode."
            }
            Write-Output "[$Mode] malformed JSON recovered: command=$($parseErr.command), success=$($parseErr.success)"

            # 7. Verify session loop stays responsive after parse error
            $stdinWriter.WriteLine('{"id":"p5","type":"get_state"}')
            $stateAfter = & $readUntil { param($f) $f.type -eq 'response' -and $f.id -eq 'p5' }
            if (-not $stateAfter.success -or $stateAfter.command -ne 'get_state') {
                throw "OMP RPC did not recover after malformed JSON in --mode $Mode."
            }
            Write-Output "[$Mode] post-parse recovery get_state: success=$($stateAfter.success)"
        }

        # 8. Close stdin and drain stdout to EOF before waiting for exit
        $stdinWriter.Dispose()
        $stdinWriter = $null
        while ($true) {
            $remainingMs = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            if ($remainingMs -le 0) {
                throw "Timed out draining OMP RPC stdout during shutdown in --mode $Mode."
            }
            $drainTask = $process.StandardOutput.ReadLineAsync()
            if (-not $drainTask.Wait($remainingMs)) {
                throw "Timed out draining OMP RPC stdout line during shutdown in --mode $Mode."
            }
            if ($null -eq $drainTask.Result) {
                break
            }
        }

        $waitMs = [Math]::Max(1000, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        if (-not $process.WaitForExit($waitMs)) {
            throw "OMP RPC process did not exit cleanly after stdin EOF in --mode $Mode."
        }
        if ($process.ExitCode -ne 0) {
            $errText = if ($stderrTask.Wait(1000)) { $stderrTask.Result } else { '' }
            throw "OMP RPC exited with code $($process.ExitCode) in --mode $Mode. Stderr: $errText"
        }
        Write-Output "[$Mode] clean shutdown: exitCode=$($process.ExitCode)"
    } finally {
        if ($null -ne $stdinWriter) {
            try { $stdinWriter.Dispose() } catch {}
        }
        if (-not $process.HasExited) {
            try { $process.Kill() } catch {}
        }
        $process.Dispose()
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$resolvedOmp = Resolve-OmpExecutable -Candidate $OmpPath
& $resolvedOmp --version
if ($LASTEXITCODE -ne 0) {
    throw "OMP version check failed with exit code $LASTEXITCODE."
}

Test-UnconfiguredRpcFailsFast -ResolvedOmpPath $resolvedOmp -TimeoutSeconds $TimeoutSeconds
Invoke-OmpRpcProbe -ResolvedOmpPath $resolvedOmp -Mode 'rpc' -TimeoutSeconds $TimeoutSeconds -IncludeRecoveryChecks
Invoke-OmpRpcProbe -ResolvedOmpPath $resolvedOmp -Mode 'rpc-ui' -TimeoutSeconds $TimeoutSeconds
Invoke-OmpRpcProbe -ResolvedOmpPath $resolvedOmp -Mode 'rpc-ui' -TimeoutSeconds $TimeoutSeconds -UseSessionDirContinue
