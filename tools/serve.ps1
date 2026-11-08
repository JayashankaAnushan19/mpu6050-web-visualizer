# Minimal static file server used by start.bat.
# Serves -Root on http://localhost:<Port>/ (local machine only) and optionally
# opens -Open in -Browser ("default" = system default browser).
param(
  [string]$Root = (Join-Path $PSScriptRoot '..\web'),
  [int]$Port = 8000,
  [string]$Open = '',
  [string]$Browser = 'default'
)

$Root = (Resolve-Path $Root).Path.TrimEnd('\')
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json'
  '.svg'  = 'image/svg+xml';            '.png' = 'image/png'
  '.jpg'  = 'image/jpeg';               '.ico' = 'image/x-icon'
  '.csv'  = 'text/csv'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "  Could not start the server on port $Port. Is another copy already running?" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)"
  Read-Host '  Press Enter to exit'
  exit 1
}
Write-Host "  Serving $Root" -ForegroundColor Green

if ($Open) {
  if ($Browser -eq 'default') { Start-Process $Open } else { Start-Process $Browser $Open }
}

function Send-File($ctx) {
  $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
  if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
  $file = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
  $res = $ctx.Response

  # Only serve files inside $Root (blocks ../ tricks).
  if ($file.StartsWith($Root + '\') -and (Test-Path -LiteralPath $file -PathType Leaf)) {
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    $res.ContentType = $(if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' })
    $res.Headers['Cache-Control'] = 'no-cache'
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
  $res.Close()
}

try {
  while ($listener.IsListening) {
    # Poll so Ctrl+C can interrupt between requests.
    $pending = $listener.GetContextAsync()
    while (-not $pending.AsyncWaitHandle.WaitOne(250)) { }
    $ctx = $pending.GetAwaiter().GetResult()
    try { Send-File $ctx } catch { Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Yellow }
    Write-Host ("  {0,-4} {1} {2}" -f $ctx.Request.HttpMethod, $ctx.Request.Url.AbsolutePath, $ctx.Response.StatusCode)
  }
} finally {
  $listener.Stop()
}
