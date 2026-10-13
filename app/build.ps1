# Build the Btrace app's engine (WebAssembly) into app/web/pkg.
# Needs: Rust with the wasm32-unknown-unknown target, and wasm-pack.
#
# wasm-pack prints progress on stderr, which Windows PowerShell 5.1 turns into
# errors under $ErrorActionPreference = "Stop"; so check the exit code instead.
Push-Location "$PSScriptRoot\wasm"
try {
    wasm-pack build --release --target web --out-dir ..\web\pkg --no-typescript 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "wasm-pack failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
