# Release a new version of the Btrace desktop app.
#
#   powershell -ExecutionPolicy Bypass -File app\desktop\release.ps1 0.2.0
#
# Sets the version everywhere it lives, commits, tags v<version>, and pushes
# the branch and that one tag. The tag starts the "Desktop release" GitHub
# Action, which builds the signed installer and publishes the release;
# installed copies of Btrace then offer the update on their next start.
param(
    [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 1.2.3 (got '$Version')"
}
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

if (git status --porcelain) {
    throw "Commit or stash your changes first; a release is cut from a clean tree."
}
$tag = "v$Version"
if (git tag --list $tag) {
    throw "Tag $tag already exists."
}

function Set-Version([string]$path, [string]$pattern, [string]$replacement) {
    $text = [IO.File]::ReadAllText($path)
    $new = [regex]::Replace($text, $pattern, $replacement, 'Multiline')
    if ($new -eq $text) { throw "Couldn't find the version in $path" }
    [IO.File]::WriteAllText($path, $new)
}

$desktop = "$root\app\desktop"
Set-Version "$desktop\src-tauri\tauri.conf.json" '^(  "version": )"[^"]*"' "`$1`"$Version`""
Set-Version "$desktop\package.json" '^(  "version": )"[^"]*"' "`$1`"$Version`""
Set-Version "$desktop\src-tauri\Cargo.toml" '^(version = )"[^"]*"' "`$1`"$Version`""

# Keep Cargo.lock's entry for the app in step (no network needed).
cargo update --manifest-path "$desktop\src-tauri\Cargo.toml" -p btrace-desktop --offline 2>&1 | Out-Null

git add "$desktop\src-tauri\tauri.conf.json" "$desktop\package.json" "$desktop\src-tauri\Cargo.toml" "$desktop\src-tauri\Cargo.lock"
git commit -q -m "Release $tag"
git tag $tag

$branch = git rev-parse --abbrev-ref HEAD
git push origin "${branch}:main"
git push origin $tag   # only this tag, never --tags

Write-Host ""
Write-Host "Released $tag. The GitHub Action is building it:"
Write-Host "  https://github.com/barrytickle/btrace/actions"
