param([string]$OmpPath = 'omp')

$ErrorActionPreference = 'Stop'

function Read-OmpConfig {
    $output = & $OmpPath config @args --json
    if ($LASTEXITCODE -ne 0) {
        throw "OMP config $args failed with exit code $LASTEXITCODE."
    }
    ($output -join "`n") | ConvertFrom-Json
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    & $OmpPath --version
    if ($LASTEXITCODE -ne 0) {
        throw "OMP version check failed with exit code $LASTEXITCODE."
    }

    $project = Read-OmpConfig list --scope=project
    foreach ($key in 'task.isolation.apply', 'task.speculativeLaunch') {
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

    $ignoreRule = & git check-ignore -v -- .omp/STATUS.md
    if ($LASTEXITCODE -ne 0 -or $ignoreRule -notmatch '^\.gitignore:\d+:/\.omp/STATUS\.md\t\.omp/STATUS\.md$') {
        throw 'The repository .gitignore must exclude the untracked .omp/STATUS.md ledger.'
    }
    Write-Output 'The workstream ledger is ignored by the repository.'
} finally {
    Pop-Location
}
