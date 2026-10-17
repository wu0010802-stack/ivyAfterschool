#!/usr/bin/env bash
# INFRA-055：建立 e2e 專用 admin（CI 的 e2e workflow 用，本機可重跑）。
#
# 需要 env：E2E_ADMIN_USERNAME、E2E_ADMIN_PASSWORD（CI 每次 run 以 openssl rand 產生並 add-mask）。
# 選用 env：E2E_API_URL（預設 http://127.0.0.1:8341）、E2E_ORIGIN（預設 http://127.0.0.1:5341，必須在 API 的
#           CORS_ORIGINS 內：不安全方法帶不被允許的 Origin 會被 403，BACKEND-019）。
#
# 1) `python -m app.cli create-admin`（BACKEND-065）建立帳號；初始密碼每次隨機產生，經 stdin 帶入（非 tty 時
#    getpass 讀 stdin）。帳號已存在（「帳號已被使用」）時略過後續步驟、exit 0。
# 2) 以初始密碼登入 API，`POST /api/admin/auth/change-password` 改成 E2E_ADMIN_PASSWORD（清除 must_change_password）。
#
# 密碼只經 stdin 與暫存檔傳遞：不 echo、不放命令列參數、不開 set -x。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${E2E_API_URL:-http://127.0.0.1:8341}"
ORIGIN="${E2E_ORIGIN:-http://127.0.0.1:5341}"
DISPLAY_NAME='E2E 管理員'
TAKEN_MESSAGE='帳號已被使用'

if [ -z "${E2E_ADMIN_USERNAME:-}" ] || [ -z "${E2E_ADMIN_PASSWORD:-}" ]; then
    echo "錯誤：缺少 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD" >&2
    exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# 初始密碼：隨機英數，再補一個字母與數字以符合密碼強度規則
INITIAL_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9')a1"
export INITIAL_PASSWORD

set +e
create_output="$(
    cd "$ROOT/apps/api" &&
        python3 -c 'import os; p = os.environ["INITIAL_PASSWORD"]; print(p); print(p)' |
        uv run --frozen python -m app.cli create-admin --username "$E2E_ADMIN_USERNAME" --display-name "$DISPLAY_NAME" 2>&1
)"
create_status=$?
set -e

if [ "$create_status" -ne 0 ]; then
    if grep -q "$TAKEN_MESSAGE" <<<"$create_output"; then
        echo "e2e admin $E2E_ADMIN_USERNAME 已存在，略過建立與改密碼"
        exit 0
    fi
    echo "錯誤：建立 e2e admin 失敗（exit $create_status）：" >&2
    echo "$create_output" >&2
    exit 1
fi
echo "已建立 e2e admin $E2E_ADMIN_USERNAME，接著改成 E2E_ADMIN_PASSWORD"

# request body 由 python 從 env 組 JSON，經 stdin 交給 curl，不經命令列參數
json_body() {
    python3 -c 'import json, os, sys; print(json.dumps({k: os.environ[v] for k, v in zip(sys.argv[1::2], sys.argv[2::2])}))' "$@"
}

post() {
    # post PATH：body 讀 stdin；回傳 HTTP 狀態碼，回應內容寫到 $workdir/response
    curl -sS -o "$workdir/response" -w '%{http_code}' \
        -b "$workdir/cookies" -c "$workdir/cookies" \
        -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
        --data-binary @- "$API_URL$1"
}

status="$(json_body username E2E_ADMIN_USERNAME password INITIAL_PASSWORD | post /api/admin/auth/login)"
if [ "$status" != 200 ]; then
    echo "錯誤：以初始密碼登入失敗（HTTP $status）" >&2
    exit 1
fi

status="$(json_body current_password INITIAL_PASSWORD new_password E2E_ADMIN_PASSWORD | post /api/admin/auth/change-password)"
if [ "$status" != 200 ]; then
    # 回應只含錯誤碼與訊息（例如 weak_password），不含密碼
    echo "錯誤：改密碼失敗（HTTP $status）：$(cat "$workdir/response")" >&2
    exit 1
fi
echo "e2e admin $E2E_ADMIN_USERNAME 已就緒"
