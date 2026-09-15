$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$toolDir = Join-Path $root 'work/e7/tools'
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null

function Get-CheckedTool($url, $filename, $digest) {
    $file = Join-Path $toolDir $filename
    if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $digest) {
        curl.exe -fL --retry 2 --silent --show-error $url -o $file
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $filename" }
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $digest) { throw "Checksum mismatch for $filename" }
}

Get-CheckedTool 'https://github.com/k3d-io/k3d/releases/download/v5.9.0/k3d-windows-amd64.exe' 'k3d.exe' '49d0b9c796f5b8ba6f58a1dd5469e8b7b34bf9b6ce9078633eedb2789680a034'
Get-CheckedTool 'https://dl.k8s.io/v1.34.3/bin/windows/amd64/kubectl.exe' 'kubectl.exe' '5ef6e0b019cfea5b0eff55b576c0118f64c0758a8bcbf52587c7f454f302f7bc'
