#!/bin/bash
# 더블클릭하면 워크스페이스 정적 서버를 띄우고 브라우저로 Aethering을 연다.
cd "$(dirname "$0")/.." || exit 1
PORT=8123
# 이미 떠 있으면 재사용
if ! curl -s -o /dev/null "http://localhost:$PORT/mmo/index.html"; then
  python3 -m http.server "$PORT" >/tmp/mmo_server.log 2>&1 &
  sleep 1
fi
open "http://localhost:$PORT/mmo/"
echo "서버: http://localhost:$PORT/mmo/  (종료하려면 이 창을 닫거나 python http.server 프로세스를 끄세요)"
