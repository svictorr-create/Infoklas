#!/usr/bin/env bash
# ІнфоКлас — підготовка учнівського ПК з Linux Mint (Cinnamon / Xfce / MATE).
# Запуск (від адміністратора):   sudo bash setup-mint.sh infoklas-kiosk_1.0.0_amd64.deb [--autologin] [--autostart]
#
# Що робить:
#  1. встановлює кіоск-клієнт з .deb;
#  2. створює обліковий запис учня "uchen" БЕЗ прав адміністратора (якщо його немає);
#  3. вимикає перемикання в текстові консолі (Ctrl+Alt+F1…F6) і аварійне вбивство X (Ctrl+Alt+Backspace);
#  4. вимикає гостьовий сеанс; з --autologin — ПК після ввімкнення одразу входить у "uchen";
#  5. кіоск НЕ стартує сам — вчитель запускає його через Veyon (`infoklas-kiosk --open`).
#     При вході учня лише відновлюються системні клавіші, якщо кіоск минулого разу завершився аварійно.
#     З --autostart кіоск запускатиметься автоматично під час входу (заблокованим).
set -euo pipefail

STUDENT=uchen
DEB="${1:-}"
AUTOLOGIN=0
AUTOSTART=0
for a in "$@"; do
  [ "$a" = "--autologin" ] && AUTOLOGIN=1
  [ "$a" = "--autostart" ] && AUTOSTART=1
done
case "$DEB" in --*) DEB="" ;; esac  # перший аргумент — параметр, а не файл

if [ "$(id -u)" -ne 0 ]; then echo "Запустіть через sudo: sudo bash $0 файл.deb [--autologin] [--autostart]"; exit 1; fi

echo "== 1. Встановлення кіоску"
if [ -n "$DEB" ] && [ -f "$DEB" ]; then
  apt-get install -y "$(realpath "$DEB")"
else
  echo "   (файл .deb не вказано — пропускаю; можна встановити пізніше: sudo apt install ./infoklas-kiosk_*.deb)"
fi
KIOSK_BIN="$(command -v infoklas-kiosk || echo /opt/InfoKlas\ Kiosk/infoklas-kiosk)"

echo "== 2. Обліковий запис учня: $STUDENT"
if ! id "$STUDENT" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Учень" "$STUDENT"
  echo "   Задайте пароль для $STUDENT (знатиме лише вчитель; з --autologin його вводити не треба):"
  passwd "$STUDENT"
fi
for g in sudo adm lpadmin; do deluser "$STUDENT" "$g" >/dev/null 2>&1 || true; done
echo "   $STUDENT не має прав адміністратора."

echo "== 3. Заборона текстових консолей і Ctrl+Alt+Backspace"
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/90-infoklas.conf <<'CONF'
Section "ServerFlags"
    Option "DontVTSwitch" "true"
    Option "DontZap"      "true"
EndSection
CONF

echo "== 4. Екран входу (LightDM)"
mkdir -p /etc/lightdm/lightdm.conf.d
{
  echo "[Seat:*]"
  echo "allow-guest=false"
  if [ "$AUTOLOGIN" = 1 ]; then
    echo "autologin-user=$STUDENT"
    echo "autologin-user-timeout=0"
  fi
} > /etc/lightdm/lightdm.conf.d/90-infoklas.conf
[ "$AUTOLOGIN" = 1 ] && echo "   Автовхід у $STUDENT увімкнено."

if [ "$AUTOSTART" = 1 ]; then KIOSK_EXEC="\"$KIOSK_BIN\""; NAME="InfoKlas Kiosk"
else KIOSK_EXEC="\"$KIOSK_BIN\" --restore-keys"; NAME="InfoKlas: відновлення клавіш"; fi
echo "== 5. Вхід учня: $NAME"
HOME_DIR="$(getent passwd "$STUDENT" | cut -d: -f6)"
install -d -o "$STUDENT" -g "$STUDENT" "$HOME_DIR/.config/autostart"
cat > "$HOME_DIR/.config/autostart/infoklas-kiosk.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=$NAME
Exec=$KIOSK_EXEC
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=2
NoDisplay=true
Terminal=false
DESK
chown "$STUDENT:$STUDENT" "$HOME_DIR/.config/autostart/infoklas-kiosk.desktop"

# Блокування екрана й заставка не потрібні — кіоск сам блокує ПК
su - "$STUDENT" -c "dbus-run-session gsettings set org.cinnamon.desktop.screensaver lock-enabled false" >/dev/null 2>&1 || true

echo
echo "Готово. Перезавантажте ПК."
echo "Перший запуск кіоску (з Veyon: infoklas-kiosk --open) попросить адресу сервера, номер ПК і логін вчителя — це один раз."
echo "Порада: увійдіть в обліковий запис учня й переконайтеся, що Ctrl+Alt+F2 не перемикає в консоль."
