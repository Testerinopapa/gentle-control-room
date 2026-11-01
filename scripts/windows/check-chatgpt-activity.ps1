[CmdletBinding()]
param(
  [ValidateSet('Today', 'Last7Days', 'All')]
  [string]$Period = 'Today'
)

$ErrorActionPreference = 'Stop'
$folder = Join-Path $env:LOCALAPPDATA 'GentleControlRoom\BrowserActivity'
$now = Get-Date
if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
  Write-Host 'ChatGPT browser activity: no local storage folder yet.'
  Write-Host 'Open ChatGPT in Edge, click Start for this conversation, and try again.'
  exit 0
}

$files = @(Get-ChildItem -LiteralPath $folder -Filter 'events-*.jsonl' -File |
  Sort-Object Name -Descending)
$sessionIds = @{}
$startIds = @{}
$types = @{ session_started = 0; visible_counts = 0; coding_tag = 0; session_ended = 0 }
$latest = [DateTimeOffset]::MinValue
$invalid = 0
$unreadableFiles = 0
$selected = 0

foreach ($file in $files) {
  # A native write can temporarily hold an exclusive file lock; skip the
  # current file and report incomplete reads rather than crashing.
  try {
    # Don't print file contents, code, conversation identifiers or session IDs.
    foreach ($line in [System.IO.File]::ReadLines($file.FullName)) {
    try {
      $row = $line | ConvertFrom-Json -ErrorAction Stop
      if ($row.schemaVersion -ne 1 -or $row.source -ne 'chatgpt_browser' -or
          -not $types.ContainsKey([string]$row.eventType)) { continue }
      $date = [DateTimeOffset]::Parse([string]$row.timestamp,
        [System.Globalization.CultureInfo]::InvariantCulture)
      if ($date -gt [DateTimeOffset]::Now) { continue }
      $localDay = $date.LocalDateTime.Date
      if ($Period -eq 'Today' -and $localDay -ne $now.Date) { continue }
      if ($Period -eq 'Last7Days' -and $localDay -lt $now.Date.AddDays(-6)) { continue }
      $id = [guid]::Empty
      if (-not [guid]::TryParse([string]$row.sessionPseudonym, [ref]$id)) { continue }
      $selected++
      $sessionIds[$id.ToString()] = $true
      if ($row.eventType -eq 'session_started') { $startIds[$id.ToString()] = $true }
      $types[[string]$row.eventType]++
      if ($date -gt $latest) { $latest = $date }
    }
    catch {
      $invalid++
    }
    }
  }
  catch {
    $unreadableFiles++
  }
}

Write-Host "Local event files: $($files.Count)"
Write-Host "Temporarily unreadable files: $unreadableFiles"
Write-Host "Selected period: $Period"
Write-Host "Recorded sessions: $($sessionIds.Count)"
Write-Host "Confirmed starts: $($startIds.Count)"
Write-Host "Message count updates: $($types['visible_counts'])"
Write-Host "Coding tags recorded: $($types['coding_tag'])"
Write-Host "Session ends: $($types['session_ended'])"
Write-Host "Unreadable rows: $invalid"
if ($selected -gt 0) {
  Write-Host ("Latest activity: {0:yyyy-MM-dd HH:mm:ss}" -f $latest.ToLocalTime())
} else {
  Write-Host 'No accepted events in the selected period.'
}
Write-Host 'No conversation text, IDs or file paths were printed.'
