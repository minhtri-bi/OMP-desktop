param([string]$OmpPath = 'omp')

$ErrorActionPreference = 'Stop'

function Read-OmpConfig {
    $output = & $OmpPath config @args --json
    if ($LASTEXITCODE -ne 0) {
        throw "OMP config $args failed with exit code $LASTEXITCODE."
    }
    $parsed = ($output -join "`n") | ConvertFrom-Json
    if ($null -eq $parsed) {
        throw "OMP config $args returned empty JSON."
    }
    $parsed
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    & $OmpPath --version
    if ($LASTEXITCODE -ne 0) {
        throw "OMP version check failed with exit code $LASTEXITCODE."
    }

    $project = Read-OmpConfig list --scope=project
    foreach ($key in 'task.isolation.apply', 'task.speculativeLaunch', 'worktree.clone') {
        $property = $project.PSObject.Properties[$key]
        if ($null -eq $property -or $property.Value.value -isnot [bool] -or $property.Value.value) {
            throw "$key must be set to false in the OMP project configuration."
        }

        $effective = (Read-OmpConfig get $key).value
        if ($effective -isnot [bool] -or $effective) {
            throw "$key must resolve to false in OMP."
        }
        Write-Output "$key = false (project and effective)"
    }

    $requiredIgnores = @(
        @{ Path = '.omp/STATUS.md'; Pattern = '/.omp/STATUS.md' }
        @{ Path = '.omp/agent/__harness_probe__'; Pattern = '/.omp/agent/' }
        @{ Path = '.omp/local/__harness_probe__'; Pattern = '/.omp/local/' }
        @{ Path = '.omp/roadmap/__harness_probe__'; Pattern = '/.omp/roadmap/' }
        @{ Path = '.worktrees/__harness_probe__/'; Pattern = '/.worktrees/' }
        @{ Path = 'graphify-out/__harness_probe__'; Pattern = '/graphify-out/' }
        @{ Path = '.env'; Pattern = '.env' }
        @{ Path = '.env.local'; Pattern = '.env.*' }
    )

    foreach ($entry in $requiredIgnores) {
        $ignoreOutput = @(& git check-ignore -v -- $entry.Path)
        $exitCode = $LASTEXITCODE
        $ignoreRule = ($ignoreOutput -join "`n").Trim()
        $expectedPattern = '^\.gitignore:\d+:' + [regex]::Escape($entry.Pattern) + "`t" + [regex]::Escape($entry.Path) + '$'
        if ($exitCode -ne 0 -or $ignoreOutput.Count -ne 1 -or $ignoreRule -cnotmatch $expectedPattern) {
            throw "The repository .gitignore must exclude $($entry.Path) via $($entry.Pattern)."
        }
    }
    Write-Output 'All local coordination, worktree, graph, and env paths are ignored by .gitignore.'

    $trackedFiles = @(& git -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0) {
        throw "git ls-files failed with exit code $LASTEXITCODE."
    }
    $forbiddenTracked = @(
        $trackedFiles | Where-Object {
            $_ -imatch '^\.omp/(status\.md(?:$|/)|agent/|local/|roadmap/)' -or
            $_ -imatch '^\.worktrees/' -or
            $_ -imatch '^graphify-out/' -or
            (($_ -imatch '(^|/)\.env($|\.)') -and ($_ -inotmatch '(^|/)\.env\.example$'))
        }
    )
    if ($forbiddenTracked.Count -gt 0) {
        throw "Forbidden local or secret files are tracked in Git: $($forbiddenTracked -join ', ')"
    }
    Write-Output 'No forbidden local coordination, worktree, graph, or env files are tracked in Git.'
} finally {
    Pop-Location
}
