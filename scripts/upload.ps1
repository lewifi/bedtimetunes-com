#Requires -Version 5.1
<#
  Bedtime Tunes — MP3 uploader
  Scans a local folder, extracts the numeric ID from each filename
  (YYYYMMDD_ID_Anything.mp3 — only field 2 is read, spaces/dashes in the
  rest are ignored), uploads to Backblaze B2 as "<id>.mp3" via the S3 API,
  then POSTs {id, audio_key, duration_ms} to the Worker /api/sync endpoint.

  One-time setup:
    Install-Module AWS.Tools.S3 -Scope CurrentUser
#>

# ───────────────────────── CONFIG ─────────────────────────
$LocalFolder = "C:\Users\lewi\Dev\bedtimetunes.com\songs"   # your /songs
$B2_Endpoint = "https://s3.us-west-004.backblazeb2.com"     # your B2 region endpoint
$B2_Bucket   = "bedtimetunes"
$B2_KeyId    = $env:B2_KEY_ID      # set these as env vars; never hard-code keys
$B2_AppKey   = $env:B2_APP_KEY
$SyncUrl     = "https://audio.bedtimetunes.com/api/sync"
$SyncToken   = $env:BT_SYNC_TOKEN  # matches the Worker's SYNC_TOKEN secret
$IdCap       = 146

# ───────────────────────── checks ─────────────────────────
if (-not $B2_KeyId -or -not $B2_AppKey) { throw "Set B2_KEY_ID and B2_APP_KEY env vars." }
if (-not $SyncToken) { throw "Set BT_SYNC_TOKEN env var." }
Import-Module AWS.Tools.S3 -ErrorAction Stop
Set-AWSCredential -AccessKey $B2_KeyId -SecretKey $B2_AppKey -StoreAs bt-b2

# Best-effort MP3 duration via Windows shell metadata -> milliseconds (or $null)
function Get-DurationMs([string]$path) {
  try {
    $shell  = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace((Split-Path $path))
    $item   = $folder.ParseName((Split-Path $path -Leaf))
    $len    = $folder.GetDetailsOf($item, 27)   # 27 = Length (HH:MM:SS) on most systems
    if ($len -match '(\d+):(\d{2}):(\d{2})') { return ([int]$Matches[1]*3600 + [int]$Matches[2]*60 + [int]$Matches[3]) * 1000 }
    if ($len -match '(\d+):(\d{2})')         { return ([int]$Matches[1]*60 + [int]$Matches[2]) * 1000 }
  } catch {}
  return $null
}

# ───────────────────────── run ─────────────────────────
$syncItems = @()
$files = Get-ChildItem -Path $LocalFolder -Filter *.mp3 -File
Write-Host "Found $($files.Count) mp3 files." -ForegroundColor Cyan

foreach ($f in $files) {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)

  # Extract ID = the second underscore field (date_ID_...). Pure-digit, position-locked.
  if ($base -notmatch '^\d{8}_(\d+)_') {
    Write-Host "  SKIP (no id): $($f.Name)" -ForegroundColor DarkYellow
    continue
  }
  $id = [int]$Matches[1]
  if ($id -gt $IdCap) { Write-Host "  SKIP (id $id > $IdCap): $($f.Name)" -ForegroundColor DarkYellow; continue }

  $key = "$id.mp3"
  try {
    Write-S3Object -BucketName $B2_Bucket -Key $key -File $f.FullName `
      -EndpointUrl $B2_Endpoint -ProfileName bt-b2 -ContentType "audio/mpeg" -ErrorAction Stop
    $dur = Get-DurationMs $f.FullName
    $syncItems += [ordered]@{ id = $id; audio_key = $key; duration_ms = $dur }
    Write-Host "  OK   id=$id -> $key  ($([math]::Round($f.Length/1MB,1)) MB$( if($dur){", $([math]::Round($dur/1000))s"} ))" -ForegroundColor Green
  } catch {
    Write-Host "  FAIL id=$id : $($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($syncItems.Count -eq 0) { Write-Host "Nothing uploaded; no sync." -ForegroundColor Yellow; return }

# Batch-sync all at once (Worker accepts a JSON array)
$body = ($syncItems | ForEach-Object { [pscustomobject]$_ }) | ConvertTo-Json -Depth 4
if ($syncItems.Count -eq 1) { $body = "[$body]" }   # ensure array shape
try {
  $resp = Invoke-RestMethod -Uri $SyncUrl -Method Post -ContentType 'application/json' `
            -Headers @{ Authorization = "Bearer $SyncToken" } -Body $body
  Write-Host "Synced: updated=$($resp.updated)  missing-ids=[$($resp.missing -join ',')]" -ForegroundColor Cyan
} catch {
  Write-Host "Sync failed: $($_.Exception.Message)" -ForegroundColor Red
}
