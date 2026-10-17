# 派工 Prompt

新 session 啟動實作時，第一則訊息貼：

> 請完整讀 `/Users/user/personal_project/ivy/afterschool/docs/tasks/kickoff_prompt.md`，以協調者（team-lead）身分照它的流程推進下一輪實作。

本檔只放「怎麼開始」與「目前有效的狀態與規則」。流程規則以 `docs/tasks/README.md` 為準、測試規則以 `docs/testing_conventions.md` 為準；三者有出入時以那兩份為準，並回頭修本檔。依 `CLAUDE.md` 文檔規則，本檔只反映目前狀態，不保留逐輪歷史（歷史看 `git log -- docs/tasks/kickoff_prompt.md`）。**每一輪收工前更新「目前狀態」與「下一輪建議順序」兩節。**

## 協調者的角色

- 你是協調者：查可開始的 task、派實作 agent、派 reviewer、處理回報、向使用者確認決策、維護本檔。**協調者原則上不自己寫實作程式碼**，只寫 tasks.json 的狀態欄位（認領、改派）與文件。
- 使用者決策：遇到 task 的 `open_design_questions` 或 agent 回報需要業務判斷的事，用 AskUserQuestion 一次整理多題問使用者（每題 2~4 個具體選項、附推薦），答案寫回 `docs/domain_spec.md` 與對應 task 後才讓 agent 繼續。純技術、有明顯合理預設的小事自己決定，並在回報給使用者時列出。
- 動手前必讀：`CLAUDE.md`、`docs/architecture_decisions.md`、`docs/domain_spec.md`、`docs/testing_conventions.md`、`docs/tasks/README.md`。`docs/tasks/api_index.md` 是前後端 API 速查（權威仍是 BACKEND task 的 description）。

## 目前狀態

- 共 798 個 task（INFRA 56、DB 42、BACKEND 418、FRONTEND 177、PARENT 105）：done 762、blocked 27（全部 NFC）、superseded 8（BACKEND-544、DB-001、DB-034、DB-039、INFRA-003、INFRA-007、INFRA-037、INFRA-038）、pending 1（INFRA-054）。
- 架構：DB 為 PostgreSQL（雲端 Railway Postgres、本機 `compose.yaml` 的 Postgres 17.11 + SeaweedFS 模擬 R2），migration 用 Alembic（forward-only、revision id = task id；已部署的 revision 不再修改，未部署的可直接修正），檔案存 Cloudflare R2，後端以最小權限角色 `app_backend` 連線、不使用 RLS。web → api 只走 IPv6（nginx resolver `ipv4=off`，INFRA-053）。細節見 `docs/architecture_decisions.md` §2~§5、§10、§11；部署流程與上線前驗證清單見 `docs/deployment.md`。
- 各區域：
  - INFRA（done 51）：未完成剩 INFRA-054（pending；committing_db_session 的 cleanup_tables 不得 cascade 到 seed 表，使用者指示之後再做）。INFRA-056 已完成：後台 e2e 以 globalSetup 以 API 登入後存下的 storageState 登入（檔在 OS 暫存目錄、不在上傳路徑，globalTeardown 刪除），會送出密碼的測試只在整檔關 trace 的 `e2e/admin/login-form.spec.ts`，trace 不含 e2e admin 密碼；印密碼 / xtrace 靜態檢查涵蓋整份 e2e.yml。INFRA-055 已完成：CI e2e workflow 以 `scripts/e2e_bootstrap_admin.sh` 建立 e2e admin（帳密每次 run 隨機產生、`::add-mask::`），Playwright 兩個 project 的 testMatch 只收 `*.spec.ts`，`vite.config.ts` 的 `optimizeDeps.include` 以 `build/optimizeDeps.ts` 列出 element-plus 全部元件樣式（冷快取不再中途重新預打包、整頁重載）。
  - DB（done 37）：除 NFC（DB-032 / 033 blocked）外全部完成。目前 head = db040（鏈尾 … → db038 → db025 → db028 → db040）。`apps/api/tests/integration/db/test_schema_conventions.py` 動態檢查每張表的慣例。
  - BACKEND（done 398）：除 NFC（BACKEND-500~518 blocked）外全部完成。第 11 輪完成 563~569：佇列回應附 `latest_expected_arrival`（`pickup.window` 最晚預計抵達時間）、`homework_service.progress_view` 公開、commit 前去重推播抽成 `tx_hooks` 共用 helper（作業快照與接送請求共用）、作業項目 window 外可改 / 刪與核驗錯碼 / 鎖定推播補測試、committing 測試改用 seed 角色 `tutor` 建員工、升年級以 422 取代 assert。
  - FRONTEND（done 171）：除 NFC（FRONTEND-270~275 blocked）外全部完成。後台 e2e 接真實後端：290（`e2e/support`：admin 登入、API 種子資料與清理、globalSetup / globalTeardown 只在 run 期間啟用 e2e.admin）、291（今日出勤到班 / 離班 / 批次）、292（員工代建 → 回覆 → 確認 → 完成交付、第二個 context 驗 ws 即時）、293（建立考試 → 成績自動儲存 → 發布）。第 11 輪其他完成：298（回覆 / 代建時間上限改用 `latest_expected_arrival`，超過上限的快捷鈕取上限）、299~301、302 / 313（FormDialog 與全站 ElMessageBox 按鈕 ≥ 44px）、303、304~306 與 316 / 318（出勤 / 作業 / 接送 reload 晚到不覆蓋較新列、換日期途中的 ws 事件保留、合併取到較新的 arrived 也觸發 onArrived）、307（authGuard 以路由名稱判斷登入頁、刪除 PlaceholderView）、308（`encodePathSegment`，後台 api client 全面改用）、309~311、312（共用 FakeWebSocket 在 `src/test/`）、314（POS 提示列等第一下點擊完成才移除）、315（發布後成績格修改也詢問是否重新通知）、317（滿分與分數最多兩位小數）。
  - PARENT（done 105）：全部完成。第 11 輪完成 199~211：首頁「我到了」遇狀態已變更後重抓、登出中略過 401 導頁、通知未讀數取號、請假狀態膠囊共用 util、月曆 360 寬格寬 ≥ 44px、分數顯示到兩位小數不四捨五入、api client 改用 `encodePathSegment`、spec 改用共用 FakeWebSocket 等。
- 設計稿（`docs/mockups/`）：68 張 approved，沒有 draft。`index.html` 分「待核可 / 已核可」兩區。元件稿是元件外觀的權威，頁面稿只負責版面並引用元件稿。家長端 warning 色使用 `m3-tokens.css` 的 `--m3-warning-container` / `--m3-on-warning-container`；家長端層級 z-index：頂部列 5、sheet 10、dialog 15、snackbar 20；家長端頁面自帶左右 16px、底部 24px 內距，ParentLayout 不再加。
- 收工時沒有 in_review / in_progress 的 task。下一輪開工先 `docker compose ps` 確認本機 compose 服務，未起則 `flock /tmp/afterschool_db.lock timeout 300 just db-start`，並用 owner 唯讀確認 `alembic_version` 為 db040、`system_settings` 有 11 列、`roles` 4、`subjects` 5、`exam_types` 3、啟用中員工 0（e2e.admin 只在 e2e run 期間啟用）。新 session 先 `git status` / `git diff` 確認沒有被中斷的 agent 留下突變殘留（reviewer 突變驗證會暫時改壞原始檔；有殘留一律 `git diff` 檢視後交 reviewer 或實作者處理，不要直接 commit）。
- 遠端：`origin = git@github.com:samjp6jp69898/ivy-afterschool.git`（main 追蹤 origin/main）。雲端容器的工作分支是 `claude/vigilant-franklin-85andq`；遠端該分支停在 c7f27a6，之後第 10 / 11 輪的 commit 尚未 push（push 由協調者做）。下一輪若在新容器開工，先 `git fetch` 比對遠端分支與本機 HEAD，確認成果已在 GitHub。
- 工具版本基準：Python 3.13（uv）、TypeScript 鎖 `~6.0`、vite 8（rolldown）、vitest 5、pinia 4、vue-router 5、eslint 10、@playwright/test 1.63（本機已裝 chromium）；Postgres 映像 `postgres:17.11`、SeaweedFS `chrislusf/seaweedfs:4.48`；alembic 1.20、boto3 1.43、SQLAlchemy 2.1（`Select` 是 variadic generic）、FastAPI 0.142（`include_router` 是 lazy，`app.routes` 不攤平子路由，掃路由用 `fastapi.routing.iter_route_contexts(app.routes)` 或 `app.openapi()['paths']`）；starlette TestClient 回傳 `httpx2.Response`（測試型別標註用 httpx2），per-request `cookies=` 已棄用，改用 `headers={"Cookie": ...}` 或 `client.cookies`；TestClient 預設來源位址是 'testclient'（不是 IP），要驗 audit ip 用 `TestClient(app, client=("203.0.113.5", 50000))`；本機沒有 `psql`，DB 驗證用 `docker compose exec db psql -U postgres` 或 psycopg。
- 實作慣例（踩過的坑）：
  - ruff 禁 `datetime.now`（TID251），測試與 factory 一律用固定時間或注入的 clock；`app/models/base.py` 的 `Base.type_annotation_map` 有 `str → Text`，inet 用 `InetText`；非 naming convention 的約束名稱要在 model 明確指定；scheduled job 只 flush、由 runner commit（BACKEND-018 的 advisory lock 是交易級）；SQLSTATE 反例要設計成只違反一條約束，reviewer 會 drop 約束自證。
  - service 不 commit，例外只有兩處：BACKEND-037 rotate 重用分支、BACKEND-043 / 058 refresh 的 401 撤銷路徑。endpoint 要在錯誤回應附 cookie（例如 refresh 401 清 cookie）時用 `app/core/errors.py` 的 `error_response(exc)` 自組回應（exception handler 另建回應會丟掉 Set-Cookie）。
  - **鎖**：`with_for_update()` 遇到 `lazy="joined"` 的 relationship 要寫 `of=<Model>`；同一 session 可能已載入該列（例如 `get_current_staff` 已載入 actor 的員工與角色）時一律加 `execution_options(populate_existing=True)`，否則讀到 identity map 舊值、鎖形同虛設。「先查再寫」流程先鎖父列序列化（班級寫入鎖班級列、新增 / 改班學生對班級列取 FOR SHARE、上限計數鎖學生列）；可能讓系統失去管理者的異動先取 `advisory_xact_lock(session, 'rbac:admin_retained', 'global')`。**全專案鎖序約定**：作業進度列 → 接送請求列；代理授權列 → 接送請求列 → 出勤列；請假列 → 出勤列；批次鎖多列一律依主鍵排序（回報仍依輸入順序）。新流程不得反向，review 會以兩 session 真實函式重現 40P01。並發測試用兩條 app_backend 連線 + threading（阻塞模式），每條連線 `SET LOCAL lock_timeout`、join / wait 都要有 timeout；拿掉鎖時測試必須轉紅（lock_timeout 寫法可能被 FK KEY SHARE 混淆、identity map 弱參照驗不到 populate_existing，要用持有 ORM 參照或阻塞模式）。
  - **commit 後副作用**：`app/core/tx_hooks.py` 的 `run_after_commit` 會在 savepoint rollback 時丟棄該層 callback（BACKEND-545）；enqueue / 廣播不要放在 savepoint 內。374 / 404 的 before_commit 去重推播在 commit 前讀最終狀態（查詢失敗會讓 commit 失敗，已知）。
  - **測試資料**：整合測試 factories 的唯一欄位預設值帶「本行程隨機前綴 + 序號」；`make_student` 沒有 `withdrawn_on`，要 withdrawn 先建 active 再改。**committing 測試不得往 seed 表（roles 等）寫列**：建員工一律 `make_staff(role_code="tutor")`（`make_staff(session)` 預設會建自訂 `test_*` 角色，被中斷就留殘列；BACKEND-546 / 548 的測試仍有此寫法待改）。`owner_cleanup` 類 fixture 排在 `committing_db_session` 之前並設 `lock_timeout`；在經 SQLAlchemy pool 的連線上設 lock_timeout 一律 `SET LOCAL`。committing 測試跑完以 owner 唯讀查 staff_users / 非系統 roles / students 等確認無殘列；整表計數類測試（儀表板、過期 job）依賴共用 DB 無殘列。
  - **WebSocket 測試**：`tests/integration/api/ws/` 的 receive 一律走帶逾時的 `_recv(ws)`；跑 ws 測試外層加 `timeout`（`flock /tmp/afterschool_db.lock timeout 300 ...`），否則實作退化時會無限期佔住共用 DB 鎖。
  - 依賴 `APP_SECRET_KEY` 的測試各檔自備 setenv + cache_clear fixture（已在十多個檔案重複），新測試參照 `tests/integration/models/test_pickup_models.py`。
  - request schema 一律繼承 `app/schemas/common.py` 的 `RequestModel` / `UpdateModel` / `OutModel`；寫入 integer 欄位的數值要有上限。帶分頁的列表 endpoint 以 `app/api/admin/_query.py` 的 `query_model(model)` 驗證 query。路由註冊檔 `app/api/admin/__init__.py`、`app/api/parent/__init__.py`、`app/api/ws/__init__.py`、`app/jobs/__init__.py` 同一時間只交給一個 agent，只做追加 include；固定路徑（例如 `/options`、`/read-all`）必須先於 `/{id}`。
  - **endpoint 測試**：成功 / 422 / 401 / 403 / 業務錯誤；家長端 401 同時測無 cookie 與員工 cookie、IDOR 404 body 與不存在 id 完全相同；寫入型成功案例要在請求後重讀 DB（`expire_all` 或再 GET），拿掉 `db.commit()` 要轉紅；route audit 斷言要能被該 task 的 tdd.run `-k` 選到；middleware 已對 `/api/` 全域加 `Cache-Control: no-store`，handler 自設那行驗不出差別。單筆回應一律用 service 的組裝函式（例如 `leave_service.leave_out`），不可從列表分頁回找。
  - **稽核遮罩**：`audit_service` 以子字串遮罩 password / token / secret / code_hash / id_number / health_note，`must_change_password`、`token_version` 在精確比對白名單內照實記錄（BACKEND-547）；敏感欄位異動的 after 記欄位名清單（`{"set": [...]}`）。
  - **不受信任的上傳檔**：xlsx 匯入（BACKEND-155）在交給 openpyxl 前，以 expat 掃描器對 zip 內每個 entry 套大小 / 元素數 / 深度 / 單值長度上限，並限制 entry 數、同名、壓縮法、加密；openpyxl 載入與迭代的例外一律 422。之後處理任何上傳檔比照此深度防護。
  - Python 測試檔也要過 `just typecheck <檔>`；mypy 會沿 import 檢查到其他 agent 尚未提交的檔案，多 agent 並行時 typecheck 失敗要先確認錯誤是否在自己的檔案。
  - 前端：Element Plus 元件型別由 unplugin 自動補進 `apps/web/src/components.d.ts`（vite 設定 `dirs: []`，檔內只有 element-plus 型別行，夾帶他人尚未提交的行無妨），與用到新 `el-*` 元件的 task 一起 commit，commit 前 `git diff` 確認該檔只有 Element Plus 型別行；自己起的 vite / Playwright harness 一律 `dts: false`（否則會依這次用到的元件重寫該檔、刪掉其他頁面的型別）；el-form-item 錯誤訊息有 100ms debounce，spec 斷言前要等過；多個 el-select 的選單同時留在 DOM，以 input 的 aria-controls 找對應選單。後台 http 層把網路錯誤也正規化成 `ApiError(0, 'network_error')`。家長端 refresh 409 視為另一分頁已輪替（PARENT-004）。
  - **鎖（補充）**：`with_for_update()` + `populate_existing` 的查詢必須真的取出列（`scalar_one` / `scalars` / `unique`）；只呼叫 `session.execute(...)` 不消費結果時，列鎖有取到、`populate_existing` 卻不生效（BACKEND-550 在 521 發現並修正，全專案 25 處盤點僅此一處）。並發測試：外部鎖用 `FOR KEY SHARE` 才分得出實作「有沒有先鎖列」；驗 `populate_existing` 要事先載入並持有 ORM 參照；兩個 session 都碰同一列的案例單靠列鎖就序列化，拿掉學生列鎖不會轉紅。
  - **稽核殘列**：`app_backend` 對 `audit_logs` 沒有 DELETE（append-only）；探針與突變留下的 audit 殘列要以 owner 依 id 精準清除並複查全為 0。
  - **前端型別 / 上傳**：`just web-typecheck` 約 5 秒（高負載時 1~2 分鐘，timeout 給 300 秒），每批前端 task 改 `in_review` 前、reviewer 審查前端批次時、送 PR 前各跑一次（CLAUDE.md）；錯誤不在自己的檔案就回報、不要改；`el-table-column` 的 `#default="{ row }: { row: X }"` 需在每欄前加 `<!-- @vue-generic {X} -->`（FRONTEND-295）。axios 在預設 JSON 標頭下會把 FormData 序列化成 JSON 字串而遺失檔案，`createHttpClient` 對 FormData 請求只移除預設的 `application/json` 標頭（值含該子字串才刪；明確指定的 multipart 保留，FRONTEND-294）。
  - **驗證輸出判讀**：`validate_tasks.py` 成功訊息「OK: 無 ERROR」本身含 ERROR 字樣，判斷通過用 exit code 與整行 `^OK: 無 ERROR`，不要 `grep ERROR`（會讓 agent 誤判失敗而中止在 staged 狀態）。
  - **後台 e2e（接真實後端，FRONTEND-290~293）**：規則見 `docs/testing_conventions.md` §3「後台 e2e」。要點：整個 Playwright run 包在 `flock /tmp/afterschool_db.lock timeout <秒>` 內；登入有每 IP 5 分鐘 20 次的限流（bootstrap 腳本的登入也算），短時間重跑多次會 429；291 / 292 在非營業日、292 在「現在 +30 分」晚於 `latest_expected_arrival` 時整組 skip，要驗完整流程用平移時鐘的自起 API；每次 run 後以 owner 唯讀查殘列。e2e 檔不在 web-typecheck 範圍，以 tsconfig.node 的選項（`tsc --ignoreConfig`）指定檔案檢查；Chromium 用預裝的 `/opt/pw-browsers`，不要 `playwright install`。
- async 測試用 anyio 內建 pytest plugin，`apps/api/tests/conftest.py` 已統一提供 session 級 `anyio_backend = "asyncio"`。
- 專案 `.claude/settings.json`（權限 allowlist）由使用者要求建立，尚未 commit；`.claude/pending_decisions.json`（NFC 打卡待決事項）是使用者自己的未追蹤文件。兩者都不要動、不要 commit，agent 回報 `git status` 時看到它們屬正常。

## 下一輪建議順序

依賴都已寫進 `depends_on`，一律用 `python3 scripts/validate_tasks.py . --ready [AREA]` 查。**先確認上一輪收尾**：`--in-review` 與 `in_progress` 的 task 以 tasks.json 為準（收工時：無）；服務起來後先用 owner 唯讀確認種子筆數（system_settings 11、roles 4、subjects 5、exam_types 3）與啟用中員工 0。

0. **先處理遠端**：確認 `claude/vigilant-franklin-85andq` 已 push 到 GitHub（遠端停在 c7f27a6 就先 push），再開 draft PR。push 後以 `workflow_dispatch` 實跑一次 `.github/workflows/e2e.yml`，驗證 INFRA-055 在全新 DB 上「建立 e2e admin + 以 API 改密碼」的路徑（本機共用 DB 不能 db-reset，只驗過「已存在即略過」）。
1. **INFRA-054**（cleanup_tables 不得 cascade 到 seed 表；使用者指示之後再做，完成前遵守「協調者要注意的事」的規則）。
2. **剩下的 low 殘留**（不擋，可開 chore task 或在相關 task 順手處理，見「已知待驗證 / 待決」）：前端路由連結仍以 `encodeURIComponent` 組 `/exams/{id}` 等路徑（未改 `encodePathSegment`）；FRONTEND-315 `markPublished` 只在認定草稿時生效的條件沒有測試（目前 UI 走不到）。
3. **NFC 打卡**：機器到貨、使用者回答 `--blocked` 列出的待決問題後才解除（DB-032 / 033、BACKEND-500~518、FRONTEND-270~275）。
4. **上線前**：`docs/deployment.md` 的上線前驗證清單（見「已知待驗證 / 待決」的部署項目）；LINE App 與外部瀏覽器實機確認 LIFF 轉址會原樣帶回 hash 內的 query（PARENT-030 / 033 / 197）。

## 派工方式（每一輪都照做）

1. `python3 scripts/validate_tasks.py . --ready` 查可開始的 task，決定本輪各區域要做的一批（同區域自然的一段，約 3~8 個 task）。
2. **認領**：協調者先把這批 task 改 `in_progress`、`assignee_session` 填實作 agent 名稱，commit 後再派工（不然 task 會停在 pending）。
3. **以區域為單位派實作 agent**（`Agent` 工具，`subagent_type: general-purpose`，`name` 用 `impl-<area>-r<輪次>`，同區域多位時加後綴 `impl-<area>-r<輪次><a|b|c>`）。跨區域可平行；同一區域原則上只有一個實作 agent，ready 數量多時可同時派 2~3 位，條件是協調者在派工訊息明列每位可改 / 不可碰的檔案、共用的路由註冊檔只歸一位、審查中的檔案任何人都不改。模型可依 task 的 `suggested_model` 指定（sonnet / opus / fable）。
4. 實作 agent 做完一批只能改 `in_review` 並回報；**不可以自己標 done**。
5. 收到回報、確認 commit 已落地（附 hash）後，派**全新的 reviewer**（不是實作 agent 的延續或 fork，`name` 用 `review-r<輪次>`，多位時加分工後綴），負責該批 `in_review` 的 task；同一位 reviewer 可連續審同一實作者的後續批次。reviewer 與該區域的實作 agent 不並行。
6. 通過 → reviewer 寫 `done` + `review.status = pass`；打回 → `in_progress` + `review.status = concern`，問題追加進 `risk_notes`，協調者轉給原實作 agent（`SendMessage`）修正後再送審。複審可沿用同一位 reviewer，只核對打回項。複審通過後，協調者把該 task `risk_notes` 中的打回紀錄改寫成目前仍成立的風險（文件只記最終狀態）。
7. 一輪結束：`python3 scripts/validate_tasks.py .` 零 ERROR、`--in-review` 沒有殘留；更新本檔「目前狀態」「下一輪建議順序」並 commit；向使用者回報本輪完成的 task、打回次數、新的待決問題。

### 實作 agent 派工訊息範本

```
你是 afterschool 專案的 <AREA> 實作者（session 名稱 impl-<area>-r<N>）。專案根目錄 /Users/user/personal_project/ivy/afterschool。
先讀 CLAUDE.md、docs/tasks/README.md（「實作一個 task」與「寫入 tasks.json 的規則」兩節必讀）、docs/testing_conventions.md、docs/domain_spec.md 相關章節。
本輪你負責的 task（已由協調者認領為 in_progress）：<ID 清單>。依序逐一完成：
- 讀 description / risk_notes / source_ref 指向的 ivy 原始碼（移植是依本專案規格改寫，去掉多租戶、教師端、幼稚園特有邏輯）。
- TDD：依 tdd.red_cases 寫測試 → 跑 tdd.run 確認紅 → 最小實作 → 綠 → 重構。測試 commit 與實作 commit 分開（先測試後實作）。
- 只對動到的路徑跑 lint / typecheck，禁止任何無參數的全量指令。
- 只碰你區域的檔案（見 kickoff_prompt「區域檔案界線」）；發現規格錯誤依 README「實作中發現規格有錯」處理，需要使用者決策的寫進 open_design_questions 並回報，不要自己猜。
- 完成後該 task 改 in_review（不可標 done）。
全部做完回報：每個 task 的 commit hash、tdd.run 結果（綠燈數）、偏離 description 之處與是否已修正規格、新發現的問題，並附當下 `git log --oneline -1`。
逾時或沒收到背景工作完成通知時不要空等，自己查 git log / git status 確認狀態後繼續。
```

UI task（`apps/web/src/{views,components}/`、`apps/web/src/parent/{views,components}/`）另外加一段：

```
這批包含 UI task。寫任何測試或程式碼前，先依 .claude/skills/ui-design-preview/SKILL.md 出稿（docs/mockups/），把稿的絕對路徑、涵蓋 task、decisions 重點、待裁定問題回報給協調者後停手，等使用者核可（preview-status=approved）才開始 TDD。
```

### reviewer 派工訊息範本

```
你是 afterschool 專案本輪的獨立 reviewer（session 名稱 review-r<N>），沒有參與實作。專案根目錄 /Users/user/personal_project/ivy/afterschool。
先讀 CLAUDE.md、docs/tasks/README.md（「執行方式」第 3 節是你的檢查清單）、docs/testing_conventions.md。
本輪待審：`python3 scripts/validate_tasks.py . --in-review` 列出的 task（目前是 <ID 清單>，實作 commit 範圍 <hash..hash>）。
我剛核對過的 HEAD 是 <hash>，但我的核對是會過期的快照，請你自己用 git status / git log 再驗一次；工作區有這些 task 相關的未提交檔案就停手回報，不要代為 commit、不要還原任何東西。
逐一檢查：red_cases 都有對應且斷言具體行為的測試；實跑 tdd.run 全綠且真的選到每條 red_case（pytest 用 --collect-only 帶/不帶 -k 比對，vitest 看測試名稱清單）；commit 歷史看得出測試先於實作；實作符合 description、沒有範圍擴張或漏條件；權限守衛、家長端 IDOR、secret 不外洩、輸入驗證；risk_notes 的風險有處理；UI task 有 approved 設計稿且實作與稿（含 decisions）一致。
只擋「能構造出反例、會導致錯誤行為或未驗收」的問題；觀測不到的風格問題列為殘留寫進 review.notes，不打回。
判決寫入 tasks.json（README「寫入 tasks.json 的規則」）：通過 → status=done、review={status:pass, reviewer:<你的名稱>, notes}；打回 → status=in_progress、review.status=concern，問題追加進 risk_notes。寫入前重讀被打回項對應的程式碼，已被修好的就撤回不寫。
回報：每個 task 的判決與理由、打回項清單（可直接轉給實作者）、殘留清單，附當下 `git log --oneline -1`。
```

## 區域檔案界線

| 區域 | 可以改的路徑 |
|---|---|
| INFRA | root `justfile`、`README.md`、`scripts/`（`validate_tasks.py` 除外需協調者同意）、`compose.yaml`、`apps/api/alembic.ini`、`apps/api/alembic/env.py` 與 `script.py.mako`、`.github/`、`apps/api/pyproject.toml` 與工具設定、`apps/api/tests/conftest.py` 與 `tests/support/` 基礎接線、`apps/web/` 的 package / vite / tsconfig / vitest / eslint / playwright 設定、Dockerfile、railway.json、nginx 範本、`docs/deployment.md`、`docs/testing_conventions.md` |
| DB | `apps/api/alembic/versions/`、`apps/api/tests/integration/db/` |
| BACKEND | `apps/api/app/`、`apps/api/tests/`（`integration/db/` 與 INFRA 的基礎接線除外） |
| FRONTEND | `apps/web/src/`（`src/parent/` 除外）、`apps/web/e2e/`（後台）、`docs/mockups/page-*`、`docs/mockups/component-*` |
| PARENT | `apps/web/src/parent/`、`apps/web/e2e/`（家長端）、`docs/mockups/parent-*` |

INFRA-047 收尾時會改 `apps/api/app/models/base.py` 的 docstring（跨區例外，只改註解）。

`docs/tasks/<area>/tasks.json` 各區域只改自己的；修正規格牽涉其他區域時依 README 直接改並在 commit message 列出 task id。`docs/mockups/index.html` 由出稿者更新。

## 共用 working tree 的硬規則（全體 agent）

1. `git add` / `git commit` 一律帶明確檔案 pathspec，commit 用 `git commit -m ... -- <路徑>`（只提交指定路徑，不會帶走別人已 staged 的檔案；`git rm` 之後同樣要帶路徑 commit）；**禁止 `git add -A`、`git add <目錄>`、`git commit -a`、`git stash`、`--amend`、`--no-verify`**。commit 前 `git diff --cached --stat` 確認只有自己的檔。
2. 寫 tasks.json：寫入前 `git status --porcelain -- <檔>`，被別人改過而未提交就先停下重讀；用 Python `json.load` → 改 → `json.dump(ensure_ascii=False, indent=2)` + 結尾換行；頂層 `version` +1、`last_updated` 更新；跑 `python3 scripts/validate_tasks.py .` 零 ERROR（看完整輸出或 grep ERROR，不要只看 `tail -1`，ERROR 行可能不在最後）。多個 agent 同時活動時，整段（load → dump → add → 自檢 → commit）包在 `flock /tmp/afterschool_git.lock` 內。
3. 看到別人的可疑未提交改動：停手 → 回報協調者 → **什麼都不要還原**。reviewer 不代為 commit 實作者的檔案。
4. 任何「已 commit / 工作區乾淨」的宣稱都附當下 `git log --oneline -1`。
5. 每個 Bash 呼叫用絕對路徑或 `cd <絕對路徑> && ...`；scratchpad 檔名加自己的 agent 名前綴。
6. 起 dev server / static server 用自己的 port，用完關掉；Playwright 產生的檔只刪自己的。清理行程只用自己記錄的 pid，禁止 `pkill -f` 這類可能命中別人行程的寬鬆 pattern。
7. 含反引號的內容不要用 bash heredoc 包 Python 寫入（會被當成指令替換），改寫成獨立 `.py` 檔執行；commit message 含反引號時先寫檔再 `git commit -F <檔>`。
8. commit message 用繁體中文、說明動了哪些 task id，結尾加 `Co-Authored-By` 行（與既有歷史一致）。
9. 不要把真實個資（姓名、電話、身分證）寫進測試、fixture、commit 或回報；用擬真假資料（王小明、0912-000-123）。
10. 判斷 lint / typecheck / test 是否通過一律看指令本身的 exit code；不要把它們接 `| tail` / `| head` 後再判斷（pipe 會吃掉 exit code），需要截斷輸出時先 `set -o pipefail` 或另外印出 `$?`。
11. 本機 DB / SeaweedFS（docker compose）共用：`just db-start` / `just db-reset` / `just db-migrate` / integration 測試一律包在 `flock /tmp/afterschool_db.lock` 內；實作與 review agent 不執行 `just db-stop`，由協調者收尾時關。可能掛住的測試（WebSocket、並發 / 鎖測試、突變驗證）在 flock 內再包 `timeout <秒>`，避免單一測試長時間佔住共用 DB 鎖、擋住所有 agent；協調者發現佔鎖過久的行程時通知其擁有者，必要時由協調者終止。

## 協調者要注意的事

- **訊息會交錯**：agent 的回報常描述它收到你訊息之前的狀態。派 reviewer 或轉交打回前，先用 tasks.json 的 status 與 `git log` 核對現況，不要只看回報。
- **背景 agent 常漏接完成通知而閒置**：全部 agent 都 idle、又沒有對應行程在跑時，主動送訊息請它用 `git log` / `git status` 自己確認並繼續。
- **實作者 commit 了卻沒送審**也會發生：收尾前逐區比對 `git log` 與 tasks.json 狀態。
- **回報被截斷**（result truncated）：請該 agent 只補傳後半段，不要重做。
- **不要在 reviewer 進場後再叫實作者改同一批檔案**；轉達打回時給「結論」而不是可直接貼上執行的指令，並明確指定執行窗口。
- **同一類問題第二次打回**：請 reviewer 一次列出能構造的全部反例當驗收清單，避免逐輪釋出。
- **使用者裁定一律寫回文件**：`docs/domain_spec.md`（業務規則）或 `docs/architecture_decisions.md`（技術），再改 task，最後才讓 agent 動手。
- **整合測試需要本機 DB**：`just db-start` / `just db-reset --yes`（docker compose 的 Postgres 與 SeaweedFS）。測試一律以 `app_backend` 角色連線，看到有人改用 owner 繞過授權一律打回。
- **長時間背景工作**（e2e、整批測試）要求 agent 結束 5 分鐘內回報。
- **逐區域滾動審查**：不必等全部區域收工；某區域一批 commit 落地就可派 reviewer 審該區。關鍵路徑上的 task（例如 DB 鏈的前置 INFRA）可破例讓同區域實作 agent 繼續做「檔案完全不重疊」的下一件，派工時明列雙方不可碰的檔案。
- **reviewer 可以多位**：一位忙或用量上限時，另派新的獨立 reviewer（`review-r<N>-<分工>`），分區負責、各寫各區的 tasks.json；Opus 用量吃緊時改用 sonnet。
- **設計稿 agent**（`design-<area>-r<N>`）一律照 task description「設計稿關卡」指定的檔名出稿；要另訂分法先由協調者改 description。核可後由設計稿 agent 把裁定寫回 task（協調者明確授權範圍）。
- **打回紀錄由 reviewer / 協調者改寫**：實作者修正打回項時不要自己刪改 risk_notes 裡的打回紀錄，複審通過後才改寫成目前仍成立的風險；轉交複審時把原打回清單附給 reviewer。
- **打回訊息常被漏接**：實作者回報「佇列已清空」或沒提到打回項時，先查 tasks.json 的 status / review.status 再決定是否重送；同一 agent 第二次漏接可直接改派。
- **安全類打回第二次起**：請 reviewer 先整理完整攻擊面清單（必修 / 已安全 / 待驗證 / 驗收形式），寫成檔案交實作者當驗收清單，避免逐輪釋出。
- **kickoff 宣稱「稿已核可」前先查證**：`grep -l 'preview-tasks" content="[^"]*<task id>' docs/mockups/*.html` 確認稿的 preview-tasks 真的含該 task（只 grep task id 會命中 index.html 或順帶提及的稿）。
- **使用者裁定的推薦選項**：AskUserQuestion 時稿通常已照推薦選項畫，問完要另外確認「整張稿是否核可」再改 approved。
- **共用 DB 種子被清空（根因已確認）**：`public.system_settings` 的 DB-038 種子（11 列）曾被整表清空。根因：reviewer 的探針標了 `@pytest.mark.cleanup_tables("pickup_authorizations", "staff_users")`，`committing_db_session` teardown 以 owner 執行 `truncate ... restart identity cascade`，CASCADE 連帶清空所有以 FK 參照 `staff_users` 的表，包括 `system_settings`（`updated_by`；FK 的 ON DELETE SET NULL 對 TRUNCATE CASCADE 無效），而 conftest 的 `_SEED_TABLES` 守衛只比對 marker 直接列出的表名。後果：測試的 `update system_settings` 影響 0 列而退回 registry 預設值，出現假紅燈與假綠燈，需 `flock /tmp/afterschool_db.lock just db-reset --yes`（約 1 分鐘，重跑全部 migration）才能補回。根因修補是 INFRA-054（fixture 計算 cascade 閉包並拒絕會碰到 seed 表的清單，使用者指示之後再做）；完成前的規則：`cleanup_tables` 不得列 `staff_users`（或任何被種子表 FK 參照的表），探針與突變留下的殘列只用 owner 依 id 的 `DELETE` 清除，**禁止 `TRUNCATE`（尤其 CASCADE）與沒有 WHERE 的 `DELETE`**，殘列檢查一律納入 `system_settings`（11）、`roles`（4）、`subjects`（5）、`exam_types`（3）的種子筆數。現有測試檔列出的表都不含 `staff_users`。
- **突變還原後清 `.pyc`**：Python 以來源 mtime（秒）+ 檔案大小判斷 `.pyc` 是否過期；同長度的突變（例如預設值 30 改 31）若在同一秒內還原，會留下殘 `.pyc`，後續測試會跑到被改壞的程式。還原後一併刪除該模組的 `__pycache__/*.pyc`，並以 `cmp` 與 `git diff` 確認。
- **後續 task 與審查中的批次共用檔案**：同一位實作者連續做的下一批若會改前一批審查中的檔案（例如兩批都動同一個 endpoint 測試檔），reviewer 會因工作區有未提交改動而暫停；先審完再開下一批，或把新測試寫在新檔。
- **多位並行時工作區的未提交差異**：reviewer 看到他人（實作者，或其他 reviewer 的突變）進行中的未提交修改屬正常；只有『自己審的檔案』有未提交改動才需停手。
- **暫停 / 恢復**：使用者下「暫停」時，用 `ListAgents` 看誰在 running，只對這些 agent 發訊息，請它們做完當下一步（突變還原、判決寫入）後停手並回報工作區狀態；idle 的 agent 不要吵醒。恢復後先處理暫停期間累積的回報。
- **harness 的『像指令』標記**：agent 回報若提到 `.claude/settings.json` 之類檔名，harness 可能標記 instruction-shaped，屬誤報；內容沒有指令時照一般回報處理。
- **agent 的 Co-Authored-By**：agent 的 commit 結尾可能寫自己的實際模型（例如 Fable 5.1），不必要求改成協調者的署名。

- **雲端容器環境**：容器會無預警重啟，重啟後 dockerd 不會自己起來：`nohup dockerd > /tmp/dockerd.log 2>&1 &`，等 `docker info` 成功後 `flock /tmp/afterschool_db.lock timeout 300 just db-start`，再確認種子筆數。背景 agent 重啟後要用 `SendMessage` 以 agent id 喚回（會從 transcript 接續），並告知容器重啟、請它先 `git status` 確認自己的未提交檔案。用量上限中斷後同樣以 SendMessage 喚回。
- **同時跑測試的 agent 數**：容器只有 4 顆 CPU；超過約 8 個 vitest 行程同時跑時，重的頁面 spec 會逾時（load 20~35），`just web-typecheck` 也會超過 2 分鐘。派工時控制同時在跑測試的 agent 數，並請 agent 給 typecheck `timeout 300`。
- **共用產生檔**：`apps/web/src/components.d.ts` 會被任何未設 `dts: false` 的 vite 重寫；看到它被改而沒有人新增元件時，由協調者 `git checkout -- apps/web/src/components.d.ts` 只還原這一檔。
- **部分改寫已 done 的 task**：實作時常需要小幅改已 done 的元件或 composable（例如 usePagedList、POS 本機代建不響）。依 README：產物仍在、只被新 task 部分改寫時保留 done，由新 task 的 description 寫明改寫範圍並同步被改 task 的 description / red_cases；請 reviewer 一併跑被改 task 的 tdd.run 確認沒有回歸。範圍較大的（例如 186 的 capture 時機）另開 task。
- **核可稿已定案的事不必再問使用者**：規格與核可稿矛盾時（例如 LIFF 外部瀏覽器自動登入 vs 稿的 choice 狀態），以使用者已核可的稿為準直接定案，回報時說明依據。稿本身的 CSS 瑕疵（不改設計意圖）由設計 agent 修稿、preview-status 維持 approved。
- **e2e 跑在共用 DB 上**：後台 e2e 會建立未封存的種子資料，並在 run 期間啟用 e2e.admin（globalSetup 以 owner 只改 `staff_users.is_active`）；整合測試（例如 `test_deactivate_concurrent_last_admins`、整表計數類測試）要求沒有其他啟用中員工、沒有殘列。所以 e2e 與整合測試一律在同一把 `flock /tmp/afterschool_db.lock` 內輪流跑。run 被 timeout / SIGKILL 中止時 globalTeardown 不會執行，e2e.admin 會保持啟用：重跑一次任一 e2e，或以 owner 依 username 改回 `is_active=false`。派 e2e 實作者 / reviewer 時要求每次 run 後以 owner 唯讀回報：啟用中員工 0、未封存學生 / 班級 / 監護人 0、exams 0、進行中接送請求 0、種子筆數不變。
- **e2e 的時間條件**：291 / 292 在非營業日整組 skip，292 在「現在 +30 分」晚於佇列回應的 `latest_expected_arrival`（預設 19:00，即 18:30 之後）也整組 skip；skip 不算驗收。要在這些時段驗完整流程，agent 自起 API / Web（自己的 port），API 以 `app.dependency_overrides[get_clock]` 覆寫成營業日的時間、關掉 scheduler（`start_background=False`），瀏覽器以 `page.clock.install` 對齊；平移版 spec 複本、clock app、啟動腳本只放 scratchpad，不改 repo 檔、不改 `system_settings`。
- **登入限流**：員工登入每 IP 5 分鐘 20 次（`services/auth/throttle.py`），同一台機器上多位 agent 重跑 e2e 或 bootstrap 腳本會互相吃額度而 429；排程 e2e 驗證時錯開，429 時等滿 5 分鐘再跑，不要改限流設定。
- **reviewer 的臨時探針與突變不得 commit**：探針 spec / 測試只放 scratchpad 或做完即刪，突變做完以 `cmp` / `git diff` 確認還原；reviewer 的判決 commit 只含 tasks.json。看到 repo 內出現探針檔或突變殘留，交原 reviewer 處理，不要代為 commit。
- **vite 冷快取重新預打包**：e2e 換頁時出現「optimized dependencies changed. reloading」或「Failed to fetch dynamically imported module」，代表有依賴不在 `apps/web/build/optimizeDeps.ts` 的 `OPTIMIZE_DEPS_INCLUDE`（element-plus 元件樣式已自動全列）；把該依賴加進清單，不要以預熱頁面或重試掩蓋。

## 已知待驗證 / 待決（不要當成新發現）

- **待使用者決定的事**：除 NFC 外沒有。
- **e2e 的已知殘留**（不擋）：INFRA-055 的全新 DB bootstrap 路徑待 push 後以 workflow_dispatch 實跑；FRONTEND-292 的 realtime 測試 10 秒從該測試開始計時（`__e2eNoReload` 標記已證明沒有重新整理）；沒有跨家長端與後台、走真實後端的接送核心流程 e2e（家長端 PARENT-190 全部以替身攔截）。
- **前端的已知殘留**（不擋）：路由連結（`ExamsView` 列名稱、`StudentExamHistoryTab`、`LeavesView` 學生連結、家長端 `ExamListItem`）仍以 `encodeURIComponent` 組路徑，未改用 `encodePathSegment`；FRONTEND-315 `markPublished` 只在認定草稿時生效的條件沒有測試（目前 UI 走不到）。
- **設計稿**：全部 approved。page-leaves 展開附件列、page-pickup-authorizations、parent-page-pickup-proxy 的 sheet 底部按鈕列已在真實 Chromium 量測過版面。其他缺口：儀表板近期請假沒有假別代碼（BACKEND-490 的 RecentLeaveOut 加欄位才能上色）；SKILL 模板 `references/preview-template.html` 鎖 element-plus 2.14.5 / vue 3.5.42，package.json 與稿是 2.14.7 / 3.5.43。

- **NFC 打卡**：27 個 task blocked（DB-032/033、BACKEND-500~518、FRONTEND-270~275），機型、通訊方式、刷卡判斷規則、離線佇列、一生一卡等待機器到貨後決定。`python3 scripts/validate_tasks.py . --blocked` 列出全部問題。解除時 Alembic revision id 用 `db032` / `db033`，`down_revision` 指向當下的 head，`nfc:manage` 權限由 BACKEND-510 加入。
- **部署時實測**（清單同步在 `docs/deployment.md` 上線前驗證一節）：web → api 已由 nginx resolver `ipv4=off` 固定走 IPv6（INFRA-053），Railway healthcheck 是否也經 IPv6 連到 api（`--host ::` 只監聽 IPv6）仍待實測（INFRA-031 待決問題 (3)）；Railway edge 的來源 IP 範圍與標頭（INFRA-031 / 033，決定 `TRUSTED_EDGE_CIDRS` 與 `FORWARDED_ALLOW_IPS`，實測前寧窄勿寬）；`docs/architecture_decisions.md` §11 的四項（Railway Postgres 主版本是否為 17、`postgres` 是否為 superuser、pre-deploy 能否經 private network 連 DB 且失敗時中止部署、R2 presigned URL 在 LINE in-app browser 能否載入）。另外：雲端是否可用 `btree_gist` 且裝在 `extensions` schema（DB-018 的 exclusion constraint 寫死 `extensions.gist_uuid_ops`，裝在別的 schema 會讓 migration 失敗）；家長端 ParentBottomSheet / ConfirmDialog 的 body `overflow:hidden` 在舊版 iOS / LINE WebView 是否擋得住觸控捲動，疊層焦點還原在真實瀏覽器（含 leave 動畫期間）是否正確（目前只在 happy-dom 驗證）。
- **SeaweedFS 映像固定 tag**：`compose.yaml` 的 `chrislusf/seaweedfs` 以版本號 tag 固定，不可用 `latest` / `dev`；升版時確認 `weed mini` 的 `-bucket` / `-s3.config` 參數與 healthcheck 端點仍相容。
- **測試基礎設施的已知殘留**（不擋實作，INFRA-021 或相關 task 時評估）：justfile 的全量執行防護可被刻意構造的路徑繞過（`apps/api/tests/unit/..`、`apps/api//tests`），`just web-test` 的位置參數是 vitest filter（多帶 `src` 會跑全部 spec）；unit 測試明示 `enable_socket` 仍可連本機 DB；loopback 守衛不檢查 port（127.0.0.1 上其他專案的 DB 仍可被指到）；只把 `local_db_url` 交給非 libpq 客戶端時沒有連線後複驗。
- **DB function 的 EXECUTE 權限**：baseline revision（DB-041）以全域 default privileges 收回 postgres 新建 function 對 PUBLIC 的 EXECUTE。trigger function 不受影響；但若 function 被 CHECK 約束、DEFAULT 運算式或後端 SQL 直接呼叫，migration 必須明確 `grant execute on function ... to app_backend`，否則 app_backend 寫入 / 呼叫會 42501。`app_backend` 對 `extensions` schema 沒有 USAGE（目前沒有 task 從 SQL 呼叫 pgcrypto；DB-018 的 btree_gist exclusion constraint 實作時要實測 app_backend 寫入）。
- **macOS bash 3.2**：`$var` 後緊接全形字元會被當成變數名的一部分（unbound variable），bash 腳本 / justfile 一律寫 `${var}`。
- **schema drift**：全部已建立的業務表都有 model；`PENDING_MODEL_TABLES` 只剩 NFC 的 devices、nfc_cards（DB 尚未建表）。
- **DB-040 的檢查範圍**（不擋實作）：VERIFY_SQL 與 ACL 測試只看表層級權限，column-level grant（`grant select (id) on ... to public`）偵測不到（db040 的 revoke 迴圈會清掉，目前 schema 也沒有）；不檢查 app_backend 的 with grant option；FK 索引檢查不過濾 `indisvalid = false`（本專案不用 concurrently）。日後要補時以新 task 擴充 `test_schema_conventions.py` / `test_grants_baseline.py`。
- **規劃 review 留下的 low 項目**（不擋實作，可在相關 task 實作時順手處理或之後開票）：少數後端工具模組 task 一次包多個函式（BACKEND-223、224、013、038、404 等）。
- **鎖與並發的已知殘留**（不擋實作）：BACKEND-303 每日初始化依 student_no 多列 INSERT 與 308 批次到班依 student_id 建列，若在當天第一次初始化的瞬間對同一批尚無出勤列的學生同時執行，理論上可能互等；406 / 345 衝突時以 `.one()` 回查既有列，若該列恰在衝突後瞬間轉終態會 500（窗口極窄）；xlsx 匯入在上限內的最壞單一請求約 +93 MB，多個上傳同時進來會疊加（目前限 `students:write` 內部帳號）。
- **多 agent 協作的已知現象**：背景 agent 常在處理完一則訊息後才讀到下一則，回報會描述收到新訊息之前的狀態；同一指示可能需要重送。協調者在 reviewer 判決落地前修改規格，會與判決交錯——done 之後的規格修正一律開新 task，不回頭改已核可 task 的驗收條件。
