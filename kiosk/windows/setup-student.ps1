<#
  ІнфоКлас — підготовка учнівського ПК з Windows 10/11.
  Запуск: правою кнопкою на PowerShell → «Запустити від імені адміністратора», потім:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\setup-student.ps1 -Installer ".\InfoKlas Kiosk Setup 1.0.0.exe"

  Кіоск НЕ стартує сам: вчитель запускає його через Veyon → «Запустити програму»:
    "C:\Program Files\InfoKlas Kiosk\InfoKlas Kiosk.exe" --open
  Додаткові параметри:  -AutoLogin  (Windows одразу входить в обліковий запис учня)
                        -AutoStart  (кіоск запускається сам під час входу учня, заблокованим)

  Що робить:
   1. тихо встановлює кіоск-клієнт;
   2. створює локальний обліковий запис учня "uchen" (звичайний користувач, НЕ адміністратор);
   3. для учня вимикає: Диспетчер задач, командний рядок, редактор реєстру, Панель керування,
      «Виконати…», блокування та зміну пароля (Ctrl+Alt+Del);
   4. ховає «Змінити користувача»;
   5. з -AutoLogin — Windows одразу входить в обліковий запис учня; з -AutoStart — кіоск стартує сам.
#>
param(
  [string]$Installer = "",
  [string]$Student = "uchen",
  [switch]$AutoLogin,
  [switch]$AutoStart
)
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Запустіть PowerShell від імені адміністратора." -ForegroundColor Red; exit 1
}

# ---------- 1. Встановлення кіоску ----------
Write-Host "== 1. Встановлення кіоску" -ForegroundColor Cyan
if ($Installer -and (Test-Path $Installer)) {
  Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList "/S" -Wait
} else {
  Write-Host "   Інсталятор не вказано — пропускаю (можна встановити пізніше вручну)."
}
$KioskExe = "$env:ProgramFiles\InfoKlas Kiosk\InfoKlas Kiosk.exe"
if (-not (Test-Path $KioskExe)) { Write-Host "   Увага: не знайдено $KioskExe" -ForegroundColor Yellow }

# ---------- 2. Обліковий запис учня ----------
Write-Host "== 2. Обліковий запис учня: $Student" -ForegroundColor Cyan
$pw = Read-Host "Пароль для '$Student' (знатиме лише вчитель)" -AsSecureString
if (-not (Get-LocalUser -Name $Student -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $Student -Password $pw -FullName "Учень" -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
} else {
  Set-LocalUser -Name $Student -Password $pw
}
$usersGroup = (Get-LocalGroup -SID "S-1-5-32-545").Name   # «Користувачі» / «Users» незалежно від мови Windows
$adminsGroup = (Get-LocalGroup -SID "S-1-5-32-544").Name
Add-LocalGroupMember -Group $usersGroup -Member $Student -ErrorAction SilentlyContinue
Remove-LocalGroupMember -Group $adminsGroup -Member $Student -ErrorAction SilentlyContinue
Write-Host "   $Student — звичайний користувач без прав адміністратора."

# Створюємо профіль учня (одноразовий запуск процесу від його імені), щоб записати його налаштування
$cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$Student", $pw)
$profilePath = "$env:SystemDrive\Users\$Student"
if (-not (Test-Path "$profilePath\NTUSER.DAT")) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c exit" -Credential $cred -LoadUserProfile -WindowStyle Hidden -Wait
}
$sid = (Get-LocalUser -Name $Student).SID.Value
$profilePath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid").ProfileImagePath

# ---------- 3. Обмеження для учня (реєстр його профілю) ----------
Write-Host "== 3. Обмеження для учня" -ForegroundColor Cyan
$hive = "HKU\InfoKlasStudent"
$loaded = $false
if (-not (Test-Path "Registry::HKEY_USERS\$sid")) { reg load $hive "$profilePath\NTUSER.DAT" | Out-Null; $loaded = $true; $root = "Registry::HKEY_USERS\InfoKlasStudent" }
else { $root = "Registry::HKEY_USERS\$sid" }

function Set-Reg($path, $name, $value, $type = "DWord") {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
}
try {
  $sys = "$root\Software\Microsoft\Windows\CurrentVersion\Policies\System"
  Set-Reg $sys "DisableTaskMgr" 1            # Диспетчер задач
  Set-Reg $sys "DisableLockWorkstation" 1    # «Заблокувати» в Ctrl+Alt+Del
  Set-Reg $sys "DisableChangePassword" 1     # «Змінити пароль»
  Set-Reg $sys "DisableRegistryTools" 1      # regedit
  $exp = "$root\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
  Set-Reg $exp "NoRun" 1                     # Win+R
  Set-Reg $exp "NoControlPanel" 1            # Панель керування і Параметри
  Set-Reg "$root\Software\Policies\Microsoft\Windows\System" "DisableCMD" 1   # командний рядок
  # Автозапуск кіоску — лише за бажанням (-AutoStart); інакше прибираємо, якщо був
  $run = "$root\Software\Microsoft\Windows\CurrentVersion\Run"
  if ($AutoStart -and (Test-Path $KioskExe)) { Set-Reg $run "InfoKlasKiosk" "`"$KioskExe`"" "String" }
  elseif (Test-Path $run) { Remove-ItemProperty -Path $run -Name "InfoKlasKiosk" -ErrorAction SilentlyContinue }
} finally {
  [gc]::Collect(); Start-Sleep -Milliseconds 500
  if ($loaded) { reg unload $hive | Out-Null }
}

# ---------- 4. Налаштування комп'ютера ----------
Write-Host "== 4. Налаштування комп'ютера" -ForegroundColor Cyan
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "HideFastUserSwitching" 1
# Учні не повинні бачити заставку з блокуванням — кіоск блокує сам
Set-Reg "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization" "NoLockScreen" 1

if ($AutoLogin) {
  # Увага: пароль автовходу зберігається в реєстрі. Безпечніше — утиліта Sysinternals Autologon.
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  $wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  Set-Reg $wl "AutoAdminLogon" "1" "String"
  Set-Reg $wl "DefaultUserName" $Student "String"
  Set-Reg $wl "DefaultDomainName" $env:COMPUTERNAME "String"
  Set-Reg $wl "DefaultPassword" $plain "String"
  Write-Host "   Автовхід у '$Student' увімкнено."
}

Write-Host ""
Write-Host "Готово. Перезавантажте ПК." -ForegroundColor Green
Write-Host "Перший запуск кіоску (з Veyon) попросить адресу сервера, номер ПК і логін вчителя — це один раз."
Write-Host "Обліковий запис адміністратора не змінено — ним ви й надалі обслуговуєте ПК."
