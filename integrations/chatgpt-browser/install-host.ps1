param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)
$ErrorActionPreference = "Stop"
if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
  throw "Invalid Edge extension ID. Copy the 32-character ID from edge://extensions."
}
$project = Join-Path $PSScriptRoot "native-host\GentleControlRoom.ChatGPTHost.csproj"
$destination = Join-Path $env:LOCALAPPDATA "GentleControlRoom\BrowserNativeHost"
New-Item -ItemType Directory -Path $destination -Force | Out-Null
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $destination
if ($LASTEXITCODE -ne 0) { throw "Native host build failed." }
$exe = Join-Path $destination "GentleControlRoom.ChatGPTHost.exe"
if (!(Test-Path $exe)) { throw "Native host executable was not produced." }
$manifest = Join-Path $destination "native-host.json"
@{
  name = "org.gentlecontrolroom.chatgpt"
  description = "Opt-in local ChatGPT session metadata for Gentle Control Room"
  path = $exe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4 | Set-Content -Path $manifest -Encoding UTF8
# The native host and manifest are installed only for the current Windows user.
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\org.gentlecontrolroom.chatgpt"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "Native messaging host registered for Edge extension $ExtensionId"
Write-Host "No collection occurs until you opt into a ChatGPT tab in the extension."
