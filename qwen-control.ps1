# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
#  QWEN GATE â€” Control Panel (one-click desktop launcher)
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

$ErrorActionPreference = 'Continue'
$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:BunPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$script:Port = 26405
$script:OutLog = Join-Path $script:Root '.logs\server-out.log'
$script:ErrLog = Join-Path $script:Root '.logs\server-err.log'

$script:RST = "$([char]27)[0m"
$script:RED = "$([char]27)[91m"
$script:GRN = "$([char]27)[92m"
$script:YEL = "$([char]27)[93m"
$script:CYN = "$([char]27)[96m"
$script:MAG = "$([char]27)[95m"
$script:BLU = "$([char]27)[94m"
$script:WHT = "$([char]27)[97m"
$script:GRY = "$([char]27)[90m"
$script:BOLD = "$([char]27)[1m"

function W([string]$text) { [Console]::WriteLine($text) }

function Enable-Ansi {
    try { $null = [Console]::Write("$([char]27)[?25h") } catch {}
}

function Clear-Screen {
    try { [Console]::Clear() } catch {
        # No real console (e.g. redirected) â€” just emit newlines
        [Console]::WriteLine("`n`n`n`n`n`n`n`n")
    }
}

function Write-ColoredLog([string]$raw) {
    try {
        $j = $raw | ConvertFrom-Json
        $ts = $j.timestamp
        $t = if ($ts) { [DateTime]::Parse($ts).ToString('HH:mm:ss') } else { '        ' }
        $lvl = if ($j.level) { $j.level } else { 'info' }
        $cat = if ($j.category) { $j.category } else { '' }
        $msg = if ($j.message) { $j.message } else { $raw }
        if ($msg.Length -gt 170) { $msg = $msg.Substring(0, 170) + '..' }
        $lvlColor = switch ($lvl) {
            'error' { $script:RED }; 'warn' { $script:YEL }; 'info' { $script:GRN }
            'debug' { $script:GRY }; default { $script:WHT }
        }
        $catColor = switch -Regex ($cat) {
            'stream' { $script:MAG }
            'pool|warm|conv' { $script:CYN }
            'chat|qwen' { $script:CYN }
            'account|auth|health' { $script:YEL }
            default { $script:GRY }
        }
        $l5 = $lvl.ToUpper().PadRight(5)
        $c10 = $cat.PadRight(10)
        W "$script:GRY$t $script:RST$lvlColor$l5 $script:RST$catColor$c10$script:RST$script:WHT$msg$script:RST"
    } catch {
        W $raw
    }
}

function Get-ServerStatus {
    try {
        $r = Invoke-RestMethod "http://localhost:$script:Port/health" -TimeoutSec 3 -ErrorAction Stop
        return @{ Running = $true; Data = $r }
    } catch {
        return @{ Running = $false }
    }
}
function Show-Header {
    Clear-Screen
    $st = Get-ServerStatus
    $uptime = ''
    $acctStr = ''
    if ($st.Running) {
        $d = $st.Data
        $upSec = [Math]::Floor($d.uptime)
        if ($upSec -ge 3600) { $upStr = "$([Math]::Floor($upSec / 3600))h $([Math]::Floor(($upSec % 3600) / 60))m" }
        elseif ($upSec -ge 60) { $upStr = "$([Math]::Floor($upSec / 60))m" }
        else { $upStr = "$($upSec)s" }
        $uptime = "up $upStr"
        $a = $d.accounts
        $acctStr = "$($a.total) accts | $($a.authenticated) auth | $($a.available) avail | $($a.throttled) thr"
        $statusText = "$script:GRN(O) RUNNING$script:RST"
    } else {
        $statusText = "$script:RED(X) STOPPED$script:RST"
    }
    W "$script:BOLD$script:CYN  ============================================================$script:RST"
    W "$script:BOLD$script:CYN         Q W E N   G A T E   -   CONTROL PANEL$script:RST"
    W "$script:BOLD$script:CYN  ============================================================$script:RST"
    W "  $statusText $script:GRY$uptime  $script:RST$script:WHT$acctStr$script:RST"
    W ''
}
function Show-Menu {
    $st = Get-ServerStatus
    W "$script:BOLD$script:WHT  ------ MENU ------$script:RST"
    if ($st.Running) {
        W "  $script:GRN[1]$script:RST  (X) STOP Server       $script:GRN[2]$script:RST  (R) RESTART"
    } else {
        W "  $script:GRN[1]$script:RST  (>) START Server      $script:GRN[2]$script:RST  (R) RESTART"
    }
    W "  $script:GRN[3]$script:RST  STATUS               $script:GRN[4]$script:RST  LIVE LOGS"
    W "  $script:GRN[5]$script:RST  DASHBOARD            $script:GRN[6]$script:RST  TEST API"
    W "  $script:GRN[7]$script:RST  CONFIG               $script:GRN[8]$script:RST  HELP"
    W "  $script:GRN[0]$script:RST  EXIT"
    W ''
    Write-Host '  Choice: ' -NoNewline -ForegroundColor Cyan
}

function Start-Server {
    if ((Get-ServerStatus).Running) { W "$script:YEL  Already running.$script:RST"; Start-Sleep 2; return }
    W "$script:CYN  Starting...$script:RST"
    if (-not (Test-Path $script:BunPath)) {
        W "$script:RED  ERROR: bun.exe not found at $script:BunPath$script:RST"
        Start-Sleep 4; return
    }
    $logsDir = Join-Path $script:Root '.logs'
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
    $proc = Start-Process -FilePath $script:BunPath -ArgumentList 'src/index.tsx' -WorkingDirectory $script:Root -RedirectStandardOutput $script:OutLog -RedirectStandardError $script:ErrLog -WindowStyle Hidden -PassThru
    W "$script:GRN  PID $($proc.Id). Waiting for health...$script:RST"
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep 2
        $st = Get-ServerStatus
        if ($st.Running) {
            W "$script:GRN  OK Healthy after $(($i + 1) * 2)s - status $($st.Data.status)$script:RST"
            if ($st.Data.accounts) {
                W "$script:GRN  OK $($st.Data.accounts.total) accounts / $($st.Data.accounts.authenticated) auth$script:RST"
            }
            Start-Sleep 3; return
        }
    }
    W "$script:YEL  Not responding yet - check LIVE LOGS for errors.$script:RST"
    Start-Sleep 4
}

function Stop-Server {
    if (-not (Get-ServerStatus).Running) { W "$script:YEL  Not running.$script:RST"; Start-Sleep 2; return }
    W "$script:CYN  Stopping...$script:RST"
    Get-Process bun -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
    if (-not (Get-ServerStatus).Running) { W "$script:GRN  OK Stopped cleanly.$script:RST" }
    else { W "$script:RED  Still responding - check processes.$script:RST" }
    Start-Sleep 2
}
function Restart-Server {
    Stop-Server
    Start-Sleep 1
    Start-Server
}

function Show-Status {
    Clear-Screen
    W "$script:BOLD$script:CYN  ------ STATUS ------$script:RST"
    W ''
    $st = Get-ServerStatus
    if (-not $st.Running) {
        W "$script:RED  Server not running. Start it first.$script:RST"
        Start-Sleep 4; return
    }
    $d = $st.Data
    W "$script:WHT  Health: $script:GRN$($d.status)$script:RST   Uptime: $([Math]::Floor($d.uptime))s   InFlight: $($d.inFlight)"
    W ''
    try {
        $pool = Invoke-RestMethod "http://localhost:$script:Port/pool/stats" -TimeoutSec 3
        W "$script:CYN  POOL:"
        W "    total=$($pool.total) inUse=$($pool.inUse) warm=$($pool.warm) conversations=$($pool.conversations)"
    } catch { W "$script:GRY  (pool stats unavailable)" }
    W ''
    try {
        $accts = Invoke-RestMethod "http://localhost:$script:Port/api/accounts" -TimeoutSec 3
        W "$script:CYN  ACCOUNTS:"
        foreach ($a in $accts.accounts) {
            $mark = if ($a.authenticated) { "$script:GRN o" } else { "$script:RED x" }
            $thr = if ($a.throttled) { " $script:YEL(throttled)$script:RST" } else { '' }
            W "    $mark$script:RST $($a.email) $script:GRY reqs=$($a.totalRequests)$thr$script:RST"
        }
    } catch { W "$script:GRY  (accounts unavailable)" }
    W ''
    try {
        $models = Invoke-RestMethod "http://localhost:$script:Port/v1/models" -TimeoutSec 5
        W "$script:CYN  MODELS ($($models.data.Count)):"
        W "    $($models.data.id -join ', ')"
    } catch { W "$script:GRY  (models unavailable)" }
    W ''
    W "$script:GRY  Press any key...$script:RST"
    $null = [Console]::ReadKey($true)
}
function Show-LiveLogs {
    Clear-Screen
    W "$script:BOLD$script:CYN  ------ LIVE LOGS ------$script:RST"
    W "$script:GRY  Q/ESC=back   F=filter noise   P=pause  (noise filtered by default)$script:RST"
    W ""
    $logFile = $script:OutLog
    if (-not (Test-Path $logFile)) {
        W "$script:RED  Log file not found: $logFile$script:RST"
        W "$script:YEL  (Server must be started at least once to have logs.)$script:RST"
        Start-Sleep 3; return
    }

    function Test-Noise([string]$line) {
        if ($line -match '"level":\s*"debug"' -and $line -match '"category":\s*"http"' -and $line -match 'GET /(health|pool/stats|system/logs|metrics/model-health|accounts)') {
            return $true
        }
        if ($line -match 'bx-pp generated|bx-ua generated via bxUaGenerator') { return $true }
        return $false
    }
    function Show-LogLine([string]$line, [bool]$filter) {
        if ($filter) { if (Test-Noise $line) { return } }
        Write-ColoredLog $line
    }

    $filterNoise = $true
    $paused = $false
    W "$script:GRY  ---- recent tail (noise filtered) ----$script:RST"
    try {
        $allLines = @(Get-Content $logFile -ErrorAction SilentlyContinue)
        $startIdx = [Math]::Max(0, $allLines.Count - 60)
        for ($i = $startIdx; $i -lt $allLines.Count; $i++) {
            if ($allLines[$i]) { Show-LogLine $allLines[$i] $filterNoise }
        }
        $lastPos = $allLines.Count
        while ($true) {
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq 'Q' -or $key.Key -eq 'Escape') { return }
                elseif ($key.Key -eq 'F') {
                    $filterNoise = -not $filterNoise
                    W "$script:YEL  Filter noise: $(if ($filterNoise) { 'ON' } else { 'OFF' })$script:RST"
                }
                elseif ($key.Key -eq 'P') {
                    $paused = -not $paused
                    W "$script:YEL  Paused: $(if ($paused) { 'YES' } else { 'NO' })$script:RST"
                }
            }
            if ($paused) { Start-Sleep -Milliseconds 150; continue }
            $newAll = @(Get-Content $logFile -ErrorAction SilentlyContinue)
            if ($newAll.Count -gt $lastPos) {
                for ($i = $lastPos; $i -lt $newAll.Count; $i++) {
                    if ($newAll[$i]) { Show-LogLine $newAll[$i] $filterNoise }
                }
                $lastPos = $newAll.Count
            }
            Start-Sleep -Milliseconds 600
        }
    } catch {
        W "$script:YEL  (log stream ended)$script:RST"
        Start-Sleep 2
    }
}
function Open-Dashboard {
    Start-Process "http://localhost:$script:Port/dashboard"
    W "$script:GRN  Dashboard opened in browser.$script:RST"
    Start-Sleep 2
}

function Test-Api {
    Clear-Screen
    W "$script:BOLD$script:CYN  ------ API TEST ------$script:RST"
    W ""
    if (-not (Get-ServerStatus).Running) {
        W "$script:RED  Server not running.$script:RST"
        Start-Sleep 3; return
    }
    W "$script:GRY  Sending test prompt to qwen3.8-max...$script:RST"
    $body = '{"model":"qwen3.8-max","stream":false,"messages":[{"role":"user","content":"Say OK"}]}'
    $t = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:$script:Port/v1/chat/completions" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
        $t.Stop()
        W "$script:GRN  OK Response in $($t.ElapsedMilliseconds)ms$script:RST"
        W "$script:WHT  Model: $($r.model)$script:RST"
        W "$script:WHT  Content: $($r.choices[0].message.content)$script:RST"
        W "$script:GRY  Finish: $($r.choices[0].finish_reason)  Usage: $($r.usage.total_tokens) tokens$script:RST"
    } catch {
        $t.Stop()
        W "$script:RED  X FAILED after $($t.ElapsedMilliseconds)ms: $($_.Exception.Message)$script:RST"
        if ($_.ErrorDetails.Message) { W "$script:RED  $($_.ErrorDetails.Message)$script:RST" }
    }
    W ""
    W "$script:GRY  Press any key...$script:RST"
    $null = [Console]::ReadKey($true)
}
function Show-Config {
    Clear-Screen
    W "$script:BOLD$script:CYN  ------ CONFIG.JSON ------$script:RST"
    W ""
    $cfgPath = Join-Path $script:Root 'config.json'
    if (Test-Path $cfgPath) {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $cfg.PSObject.Properties | ForEach-Object {
            $name = $_.Name
            $v = $_.Value
            if ($name -match 'API_KEY' -and $v) { $v = '********' }
            W "  $script:CYN$($name.PadRight(35))$script:RST $script:WHT$v$script:RST"
        }
    } else {
        W "$script:RED  config.json not found$script:RST"
    }
    W ""
    W "$script:GRY  File: $cfgPath$script:RST"
    W "$script:GRY  Edit via dashboard: http://localhost:$script:Port/dashboard/settings$script:RST"
    W "$script:GRY  Press any key...$script:RST"
    $null = [Console]::ReadKey($true)
}

function Show-Help {
    Clear-Screen
    W "$script:BOLD$script:CYN  ------ HELP / API INFO ------$script:RST"
    W ""
    W "$script:WHT  API endpoint (OpenAI-compatible):$script:RST"
    W "    http://localhost:$script:Port/v1"
    W ""
    W "$script:WHT  Endpoints:$script:RST"
    W "    POST /v1/chat/completions     Chat (streaming + non-streaming)"
    W "    GET  /v1/models               List available models"
    W "    GET  /health                  Health check"
    W "    GET  /pool/stats              Session pool stats"
    W "    GET  /api/accounts            Account status"
    W ""
    W "$script:WHT  For OpenCode / Cursor / Claude Code:$script:RST"
    W "    Base URL: http://localhost:$script:Port/v1"
    W "    API Key: (empty - no key required by default)"
    W "    Models: qwen3.8-max, qwen3.7-max, qwen3.7-plus, qwen3.6-plus"
    W ""
    W "$script:WHT  Dashboard pages:$script:RST"
    W "    /dashboard            Overview (KPIs, health)"
    W "    /dashboard/accounts   Account management"
    W "    /dashboard/monitor    Request log"
    W "    /dashboard/settings   Config editor"
    W "    /dashboard/network    Network debug"
    W ""
    W "$script:WHT  Config file:$script:RST $script:Root\config.json"
    W "$script:WHT  Log files:$script:RST $script:Root\.logs\"
    W ""
    W "$script:GRY  Press any key...$script:RST"
    $null = [Console]::ReadKey($true)
}
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
#  MAIN LOOP
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
Enable-Ansi

while ($true) {
    Show-Header
    Show-Menu
    $choice = Read-Host
    $choice = $choice.Trim()
    switch ($choice) {
        '1' {
            $st = Get-ServerStatus
            if ($st.Running) { Stop-Server } else { Start-Server }
        }
        '2' { Restart-Server }
        '3' { Show-Status }
        '4' { Show-LiveLogs }
        '5' { Open-Dashboard }
        '6' { Test-Api }
        '7' { Show-Config }
        '8' { Show-Help }
        '0' {
            W "$script:CYN  Goodbye!$script:RST"
            exit 0
        }
        default {
            W "$script:RED  Invalid choice. Press 0-8.$script:RST"
            Start-Sleep 1
        }
    }
}
