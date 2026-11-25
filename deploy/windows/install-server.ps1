<#
  ІнфоКлас — встановлення СЕРВЕРА на шкільний ПК з Windows 10/11 (наприклад, ПК вчителя).
  Запуск від імені адміністратора, з теки проєкту:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\deploy\windows\install-server.ps1 -TeacherPassword "надійний-пароль"

  Що робить:
   1. встановлює Node.js LTS і NSSM (через winget), якщо їх немає;
   2. копіює систему в C:\InfoKlas і встановлює залежності;
   3. реєструє службу Windows "InfoKlas" — сервер стартує сам при ввімкненні ПК, навіть без входу в систему;
   4. відкриває порт у брандмауері для локальної мережі школи;
   5. показує адресу, яку треба вписати в кіоски учнів.
#>
param(
  [string]$TeacherPassword = "",
  [int]$Port = 3000,
  [string]$InstallDir = "C:\InfoKlas"
)
$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Запустіть PowerShell від імені адміністратора." -ForegroundColor Red; exit 1
}
$Src = Resolve-Path (Join-Path $PSScriptRoot "..\..")

function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }

Write-Host "== 1. Node.js і NSSM" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
$nodeVer = [version]((node -v).TrimStart('v'))
if ($nodeVer -lt [version]"22.5.0") { Write-Host "Потрібен Node.js 22.5+ (зараз $nodeVer). Оновіть: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Red; exit 1 }
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  winget install --id NSSM.NSSM -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}

Write-Host "== 2. Копіювання в $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir, "$InstallDir\data", "$InstallDir\logs" | Out-Null
foreach ($item in "server", "public", "package.json", "package-lock.json") { Copy-Item -Recurse -Force (Join-Path $Src $item) $InstallDir }
New-Item -ItemType Directory -Force -Path "$InstallDir\kiosk" | Out-Null
Copy-Item -Recurse -Force (Join-Path $Src "kiosk\windows") "$InstallDir\kiosk"   # скрипт підготовки учнівських ПК (роздає сервер)
Push-Location $InstallDir
npm ci --omit=dev
Pop-Location

Write-Host "== 3. Служба Windows 'InfoKlas'" -ForegroundColor Cyan
$node = (Get-Command node).Source
if (Get-Service InfoKlas -ErrorAction SilentlyContinue) { nssm stop InfoKlas | Out-Null; nssm remove InfoKlas confirm | Out-Null }
nssm install InfoKlas $node "--disable-warning=ExperimentalWarning" "server\index.js" | Out-Null
nssm set InfoKlas AppDirectory $InstallDir | Out-Null
$envs = @("PORT=$Port", "DATA_DIR=$InstallDir\data")
if ($TeacherPassword) { $envs += "TEACHER_PASSWORD=$TeacherPassword" }
nssm set InfoKlas AppEnvironmentExtra $envs | Out-Null
nssm set InfoKlas AppStdout "$InstallDir\logs\server.log" | Out-Null
nssm set InfoKlas AppStderr "$InstallDir\logs\server.log" | Out-Null
nssm set InfoKlas Start SERVICE_AUTO_START | Out-Null
nssm set InfoKlas AppExit Default Restart | Out-Null
nssm start InfoKlas | Out-Null

Write-Host "== 4. Брандмауер (лише приватні адреси шкільної мережі)" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "InfoKlas" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# Profile Any: шкільна мережа часто має тип «Загальнодоступна» — тоді правило лише для Private/Domain не діє.
# RemoteAddress — усі приватні діапазони (класи, Wi-Fi для телефонів можуть бути в різних підмережах); з інтернету порт закритий.
New-NetFirewallRule -DisplayName "InfoKlas" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any -RemoteAddress 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16 | Out-Null

Start-Sleep 3
# Перевірка: чи відповідає сервер на цьому ПК
try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:$Port/"; Write-Host "   Сервер відповідає на http://localhost:$Port" -ForegroundColor Green }
catch { Write-Host "   УВАГА: сервер не відповідає. Журнал: $InstallDir\logs\server.log" -ForegroundColor Red }
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -ExpandProperty IPAddress
Write-Host ""
Write-Host "Готово! Сервер працює як служба Windows і запускається сам." -ForegroundColor Green
Write-Host "  Вчитель на цьому ПК:   http://localhost:$Port"
foreach ($ip in $ips) { Write-Host "  Учні / кіоски в класі: http://${ip}:$Port" }
Write-Host "  Дані й резервна копія: $InstallDir\data   Журнал: $InstallDir\logs\server.log"
Write-Host "Порада: у налаштуваннях роутера закріпіть за цим ПК постійну IP-адресу."
