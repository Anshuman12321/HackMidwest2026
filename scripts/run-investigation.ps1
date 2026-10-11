param(
    [string]$Outcome = 'Restore Brazil subscription renewals without double billing.',
    [string]$RequestPath,
    [string]$OutputPath,
    [string]$CapturePath,
    [string]$NodePath,
    [string]$PythonPath
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
if (-not $NodePath) {
    $bundledNode = Join-Path $runtimeRoot 'node\bin\node.exe'
    $NodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { 'node' }
}
if (-not $PythonPath) {
    $bundledPython = Join-Path $runtimeRoot 'python\python.exe'
    $PythonPath = if ($env:RIPPLE_PYTHON) { $env:RIPPLE_PYTHON } elseif (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { 'python' }
}
$version = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or [int]($version.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node 24+ is required; supply -NodePath.' }
& $PythonPath -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required; supply -PythonPath.' }
$entry = Join-Path $PSScriptRoot '..\contracts\run-investigation.ts'
$arguments = @($entry, '--outcome', $Outcome)
if ($RequestPath) { $arguments += @('--request', $RequestPath) }
if ($OutputPath) { $arguments += @('--output', $OutputPath) }
if ($CapturePath) { $arguments += @('--capture', $CapturePath) }
$previousPython = $env:RIPPLE_PYTHON
try {
    $env:RIPPLE_PYTHON = $PythonPath
    & $NodePath @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Investigation failed; no validated preview was emitted.' }
} finally { $env:RIPPLE_PYTHON = $previousPython }
