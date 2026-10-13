# Release a new version of the Btrace desktop app.
#
#   powershell -ExecutionPolicy Bypass -File app\desktop\release.ps1 0.2.0
#
# Sets the version everywhere it lives, commits, tags v<version>, and pushes
# the branch and that one tag. The tag starts the "Desktop release" GitHub
# Action, which builds the signed installer and publishes the release;
# installed copies of Btrace then offer the update on their next start.
#
# Native tools (git, cargo) print progress on stderr, which Windows
# PowerShell 5.1 turns into errors under $ErrorActionPreference = "Stop".
# So errors are left at "Continue" and every command's exit code is checked.
param(
    [Parameter(Mandatory = $true)][string]$Version
)

function Fail([string]$message) {
    Write-Host "Release stopped: $message" -ForegroundColor Red
    exit 1
}

# Run a native command, show its output, stop if it fails.
function Run {
    $exe, $rest = $args
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Fail "'$exe' isn't installed or isn't on PATH" }
    & $exe @rest 2>&1 | ForEach-Object { "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "'$($args -join ' ')' failed (exit $LASTEXITCODE)" }
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "the version must look like 1.2.3 (got '$Version')" }
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

if (git status --porcelain) { Fail "commit or stash your changes first; a release is cut from a clean tree." }
$tag = "v$Version"
if (git tag --list $tag) { Fail "tag $tag already exists." }

function Set-Version([string]$path, [string]$pattern, [string]$replacement) {
    $text = [IO.File]::ReadAllText($path)
    if (-not [regex]::IsMatch($text, $pattern, 'Multiline')) { Fail "couldn't find the version in $path" }
    [IO.File]::WriteAllText($path, [regex]::Replace($text, $pattern, $replacement, 'Multiline'))
}

Write-Host "Setting version $Version"
$desktop = "$root\app\desktop"
Set-Version "$desktop\src-tauri\tauri.conf.json" '^(  "version": )"[^"]*"' "`$1`"$Version`""
Set-Version "$desktop\package.json" '^(  "version": )"[^"]*"' "`$1`"$Version`""
Set-Version "$desktop\src-tauri\Cargo.toml" '^(version = )"[^"]*"' "`$1`"$Version`""

# Keep Cargo.lock's entry for the app in step (no network needed).
Run cargo update --manifest-path "$desktop\src-tauri\Cargo.toml" -p btrace-desktop --offline

Run git add "$desktop\src-tauri\tauri.conf.json" "$desktop\package.json" "$desktop\src-tauri\Cargo.toml" "$desktop\src-tauri\Cargo.lock"
# Already at this version (e.g. the first release): tag the current commit.
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Run git commit -q -m "Release $tag" }
Run git tag $tag

$branch = git rev-parse --abbrev-ref HEAD
Write-Host "Pushing $branch and $tag"
Run git push origin "${branch}:main"
Run git push origin $tag   # only this tag, never --tags

Write-Host ""
Write-Host "Released $tag. GitHub is building it (about 10 minutes):" -ForegroundColor Green
Write-Host "  https://github.com/barrytickle/btrace/actions"
