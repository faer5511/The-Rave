#!/bin/bash
# Запуск THE RAVE одной командой: bash start.sh
cd "$(dirname "$0")" || exit 1
echo "=== THE RAVE: подготовка (первый раз займёт 1–2 минуты) ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "Не найден Python 3. Установите его с https://www.python.org/downloads/ и запустите снова."
  exit 1
fi

[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q --disable-pip-version-check -r requirements.txt || { echo "Не удалось установить библиотеки. Проверьте интернет."; exit 1; }

[ -f .env ] || cp .env.example .env

# нужен ли пароль админки?
NEED_PW=$(python - <<'PY'
import re
s = open(".env", encoding="utf-8").read()
m = re.search(r"^ADMIN_PASSWORD=(.*)$", s, re.M)
print("no" if m and m.group(1).strip() else "yes")
PY
)
PW=""
if [ "$NEED_PW" = "yes" ]; then
  echo ""
  read -r -p "Придумайте пароль для админки (запомните его) и нажмите Enter: " PW
fi

PW="$PW" python - <<'PY'
import os, re, secrets
s = open(".env", encoding="utf-8").read()
def setv(s, key, val):
    if re.search(r"^%s=.*$" % key, s, re.M):
        return re.sub(r"^%s=.*$" % key, lambda m: "%s=%s" % (key, val), s, flags=re.M)
    return s.rstrip("\n") + "\n%s=%s\n" % (key, val)
pw = os.environ.get("PW", "").strip()
if pw:
    s = setv(s, "ADMIN_PASSWORD", pw)
m = re.search(r"^SECRET_KEY=(.*)$", s, re.M)
if not m or not m.group(1).strip() or m.group(1).startswith(("change-me", "dev-secret")):
    s = setv(s, "SECRET_KEY", secrets.token_hex(32))
open(".env", "w", encoding="utf-8").write(s)
PY

python -m app.seed

echo ""
echo "=============================================="
echo " Сайт:    http://localhost:8000"
echo " Админка: http://localhost:8000/admin"
echo " Чтобы остановить сайт: нажмите Ctrl+C"
echo " Это окно закрывать нельзя, пока сайт работает"
echo "=============================================="
python -m uvicorn app.main:app --port 8000
