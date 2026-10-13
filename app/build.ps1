# Build the Btrace app's engine (WebAssembly) into app/web/pkg.
# Needs: Rust with the wasm32-unknown-unknown target, and wasm-pack.
$ErrorActionPreference = "Stop"
Push-Location "$PSScriptRoot\wasm"
try {
    wasm-pack build --release --target web --out-dir ..\web\pkg --no-typescript
} finally {
    Pop-Location
}
