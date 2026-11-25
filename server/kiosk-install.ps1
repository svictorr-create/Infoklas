<#
  ІнфоКлас — АВТОМАТИЧНЕ встановлення кіоску на учнівський ПК з Windows 10/11.
  Цей файл формує сервер ІнфоКлас (адреса сервера й ключ встановлення вже підставлені).

  Що робить:
   1. питає номер ПК (пропонує номер з імені комп'ютера, напр. KAB12-PC05 -> 5);
   2. завантажує з сервера інсталятор кіоску і скрипт підготовки;
   3. встановлює кіоск, створює запис "uchen" без прав адміністратора, вмикає обмеження й автозапуск;
   4. реєструє ПК на сервері (без вікна «Перше налаштування») і записує налаштування кіоску для "uchen".
#>
param(
  [int]$Pc = 0,
  [string]$StudentPassword = "",
  [switch]$AutoLogin,
  [switch]$Yes            # не питати номер ПК, якщо його вдалося взяти з імені комп'ютера
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # без цього Invoke-WebRequest у Windows PowerShell 5.1 завантажує дуже повільно
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Server = "__SERVER__"
$Token = "__TOKEN__"
$Student = "uchen"

function Fail($msg) { Write-Host ""; Write-Host "ПОМИЛКА: $msg" -ForegroundColor Red; exit 1 }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "запустіть від імені адміністратора (правою кнопкою -> Запуск від імені адміністратора)."
}
Write-Host ""
Write-Host "  ІнфоКлас — встановлення кіоску" -ForegroundColor Cyan
Write-Host "  Сервер: $Server   Комп'ютер: $env:COMPUTERNAME"
Write-Host ""

# ---------- Номер ПК ----------
$guess = 0
if ($env:COMPUTERNAME -match '(\d+)\D*$') { $guess = [int]$Matches[1] }
if ($Pc -le 0) {
  if ($Yes -and $guess -gt 0) { $Pc = $guess }
  else {
    $prompt = if ($guess -gt 0) { "Номер цього ПК [Enter = $guess]" } else { "Номер цього ПК (1, 2, 3 ...)" }
    $ans = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($ans)) { $Pc = $guess } else { $Pc = [int]$ans }
  }
}
if ($Pc -le 0 -or $Pc -gt 99) { Fail "невірний номер ПК." }
Write-Host "== Номер ПК: $Pc" -ForegroundColor Cyan

# ---------- Завантаження з сервера ----------
$tmp = Join-Path $env:TEMP "infoklas-install"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$exe = Join-Path $tmp "InfoKlasKioskSetup.exe"
$ps1 = Join-Path $tmp "setup-student.ps1"
Write-Host "== Завантаження інсталятора з сервера (~80 МБ)..." -ForegroundColor Cyan
try {
  Invoke-WebRequest -UseBasicParsing "$Server/kiosk/setup.exe?t=$Token" -OutFile $exe
  Invoke-WebRequest -UseBasicParsing "$Server/kiosk/setup-student.ps1?t=$Token" -OutFile $ps1
} catch { Fail "не вдалося завантажити з сервера: $($_.Exception.Message). Ключ встановлення міг закінчитися — створіть новий на сторінці «Комп'ютери»." }
Unblock-File $exe, $ps1 -ErrorAction SilentlyContinue

# ---------- Встановлення та підготовка запису учня ----------
& $ps1 -Installer $exe -Student $Student -StudentPassword $StudentPassword -AutoLogin:$AutoLogin -Quiet

# ---------- Реєстрація ПК на сервері ----------
Write-Host "== Реєстрація ПК $Pc на сервері" -ForegroundColor Cyan
$body = @{ enroll_token = $Token; computer_no = $Pc; name = $env:COMPUTERNAME } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Method Post -Uri "$Server/api/device/register" -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
} catch { Fail "сервер не зареєстрував ПК: $($_.Exception.Message)" }

# Налаштування кіоску для облікового запису учня (замість вікна «Перше налаштування ПК»)
$sid = (Get-LocalUser -Name $Student).SID.Value
$profilePath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid").ProfileImagePath
$cfgDir = Join-Path $profilePath "AppData\Roaming\infoklas-kiosk"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = [ordered]@{ server = $Server; key = $r.key; hotp_secret = $r.hotp_secret; computer_no = [int]$r.computer_no; counter = 0 } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $cfgDir "config.json"), $cfg, (New-Object Text.UTF8Encoding $false))
icacls $cfgDir /grant "${Student}:(OI)(CI)F" /T /Q | Out-Null

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "  ГОТОВО: ПК $Pc ($env:COMPUTERNAME) зареєстровано на сервері." -ForegroundColor Green
Write-Host "  Перезавантажте комп'ютер і увійдіть в обліковий запис '$Student' — кіоск стартує заблокованим."
Write-Host "  На сторінці «Комп'ютери» цей ПК з'явиться як «онлайн»."
Write-Host ""
