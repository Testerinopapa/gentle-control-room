$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\org.gentlecontrolroom.chatgpt"
if (Test-Path $key) { Remove-Item $key -Force }
Write-Host "Edge native host unregistered. Existing local events were not deleted."
Write-Host 'To delete browser events: Remove-Item "$env:LOCALAPPDATA\GentleControlRoom\BrowserActivity" -Recurse -Force'
