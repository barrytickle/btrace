# Start the PixPath app: builds the engine if needed, serves app/web locally
# and opens it in your browser. Ctrl+C stops the server.
$web = "$PSScriptRoot\web"
if (-not (Test-Path "$web\pkg\pixpath_wasm_bg.wasm")) {
    & "$PSScriptRoot\build.ps1"
    if (-not $?) { exit 1 }
}
$port = 8765
Start-Process "http://127.0.0.1:$port"
python "$PSScriptRoot\serve.py" $port
