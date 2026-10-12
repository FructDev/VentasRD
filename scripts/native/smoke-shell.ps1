param([int]$Runs = 3)
$ErrorActionPreference = 'Stop'
if ($Runs -lt 1 -or $Runs -gt 20) { throw 'SMOKE_RUN_COUNT_INVALID' }
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$binary = (Resolve-Path (Join-Path $repository 'target/debug/ventard-pos.exe')).Path
# No detener servidores/apps ajenos. El fixture exige su propio puerto cerrado.
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
    throw 'SMOKE_REQUIRES_NO_VITE_SERVER'
}
$working = Join-Path $repository ('scratch/native-shell-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $working | Out-Null
$previousFlag = $env:VENTARD_QA_SHELL_SMOKE
$env:VENTARD_QA_SHELL_SMOKE = '1'
try {
    for ($runIndex = 1; $runIndex -le $Runs; $runIndex++) {
        $stdout = Join-Path $working "run-$runIndex.stdout.log"
        $stderr = Join-Path $working "run-$runIndex.stderr.log"
        $process = Start-Process -FilePath $binary -WorkingDirectory $working -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(25)
            $ready = $false
            do {
                $process.Refresh()
                if (Test-Path $stdout) {
                    $ready = [bool](Select-String -LiteralPath $stdout -SimpleMatch 'NATIVE_UI_READY' -Quiet)
                }
                if ($ready -or $process.HasExited) { break }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $ready) { throw "NATIVE_UI_NOT_READY run=$runIndex; logs sintéticos en $working" }
            Write-Output "PASS native UI mounted run=$runIndex; packaged assets; no Vite server"
        } finally {
            # Sólo proceso creado por este harness; nunca buscar/terminar por nombre.
            $process.Refresh()
            if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
            $process.Dispose()
        }
    }
    Write-Output ('SHA256=' + (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant())
} finally {
    if ($null -eq $previousFlag) { Remove-Item Env:VENTARD_QA_SHELL_SMOKE -ErrorAction SilentlyContinue }
    else { $env:VENTARD_QA_SHELL_SMOKE = $previousFlag }
}
