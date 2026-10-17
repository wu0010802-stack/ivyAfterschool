"""CI workflow 結構測試（INFRA-022 起，後續每個 CI job task 在此檔加自己的測試）。

helper：
- `workflow(file)`：載入 .github/workflows/<file>（預設 ci.yml）。
- `job(name, file)`：取得指定 job 的 dict。
- `run_lines(name, file)`：展開該 job 所有 step 的 `run`（多行 run 拆成逐行、去掉前後空白）。
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"
CI_YML = WORKFLOWS / "ci.yml"
SETUP_ACTION = REPO_ROOT / ".github" / "actions" / "setup" / "action.yml"


def _load(path: Path) -> dict[Any, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict), f"{path} 不是 YAML mapping"
    return data


def workflow(file: str = "ci.yml") -> dict[Any, Any]:
    return _load(WORKFLOWS / file)


def triggers(file: str = "ci.yml") -> dict[str, Any]:
    wf = workflow(file)
    # YAML 1.1 會把裸字 on 解析成布林 True
    on = wf.get("on", wf.get(True))
    assert isinstance(on, dict), f"{file} 的 on 必須是 mapping"
    return on


def job(name: str, file: str = "ci.yml") -> dict[str, Any]:
    jobs = workflow(file)["jobs"]
    assert name in jobs, f"{file} 沒有 job {name}（現有：{sorted(jobs)}）"
    result: dict[str, Any] = jobs[name]
    return result


def run_lines(name: str, file: str = "ci.yml") -> list[str]:
    lines: list[str] = []
    for step in job(name, file).get("steps", []):
        run = step.get("run")
        if run:
            lines += [line.strip() for line in str(run).splitlines() if line.strip()]
    return lines


def jobs_without_valid_timeout(jobs: dict[str, Any]) -> list[str]:
    """回傳沒有 timeout-minutes 或其值不是正整數的 job 名稱。"""
    bad: list[str] = []
    for name, spec in jobs.items():
        value = spec.get("timeout-minutes")
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            bad.append(name)
    return bad


def test_ci_triggers() -> None:
    on = triggers()

    assert "pull_request" in on
    assert "push" in on
    assert on["push"]["branches"] == ["main"]
    for event in ("pull_request", "push"):
        assert on[event]["paths-ignore"] == ["docs/mockups/**"]


def test_ci_permissions_read_only() -> None:
    assert workflow()["permissions"] == {"contents": "read"}


def test_ci_triggers_concurrency_cancels_in_progress() -> None:
    assert workflow()["concurrency"] == {
        "group": "ci-${{ github.ref }}",
        "cancel-in-progress": True,
    }


def test_ci_validate_tasks_job() -> None:
    assert job("validate-tasks")["runs-on"] == "ubuntu-latest"
    assert "python3 scripts/validate_tasks.py ." in run_lines("validate-tasks")


def test_ci_every_job_has_timeout() -> None:
    assert jobs_without_valid_timeout(workflow()["jobs"]) == []

    constructed = {
        "ok": {"timeout-minutes": 5},
        "missing": {"runs-on": "ubuntu-latest"},
        "zero": {"timeout-minutes": 0},
        "text": {"timeout-minutes": "5"},
    }
    assert jobs_without_valid_timeout(constructed) == ["missing", "zero", "text"]


def test_ci_setup_action_inputs() -> None:
    action = _load(SETUP_ACTION)

    assert action["runs"]["using"] == "composite"
    inputs = action["inputs"]
    assert set(inputs) == {"python", "node"}
    assert inputs["python"]["default"] == "true"
    assert inputs["node"]["default"] == "true"
    assert "supabase" not in SETUP_ACTION.read_text(encoding="utf-8").lower()


@pytest.mark.parametrize(
    ("needle", "condition"),
    [
        ("uv sync --frozen --project apps/api", "inputs.python == 'true'"),
        ("pnpm install --frozen-lockfile", "inputs.node == 'true'"),
    ],
)
def test_ci_setup_action_steps_follow_inputs(needle: str, condition: str) -> None:
    steps = _load(SETUP_ACTION)["runs"]["steps"]
    matched = [s for s in steps if needle in str(s.get("run", ""))]

    assert len(matched) == 1
    assert matched[0]["if"] == condition


def steps_of(name: str, file: str = "ci.yml") -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = job(name, file).get("steps", [])
    return steps


def line_index(lines: list[str], *needles: str) -> int:
    """第一個同時含所有 needles 的行索引；找不到時直接讓測試失敗並印出所有行。"""
    for index, line in enumerate(lines):
        if all(needle in line for needle in needles):
            return index
    raise AssertionError(f"找不到同時含 {needles} 的行：{lines}")


def step_with_run(name: str, needle: str) -> dict[str, Any]:
    matched = [s for s in steps_of(name) if needle in str(s.get("run", ""))]
    assert len(matched) == 1, f"job {name} 含 {needle!r} 的 step 數量為 {len(matched)}"
    return matched[0]


def test_ci_lint_job_runs_ruff() -> None:
    lines = run_lines("lint")

    check = lines[line_index(lines, "ruff check", "apps/api", "scripts")]
    assert "--config apps/api/pyproject.toml" in check
    assert line_index(lines, "ruff format --check", "apps/api", "scripts") >= 0


def test_ci_lint_job_runs_eslint() -> None:
    step = step_with_run("lint", "eslint .")

    assert step["working-directory"] == "apps/web"


def test_ci_lint_job_uses_setup_action() -> None:
    assert [s for s in steps_of("lint") if s.get("uses") == "./.github/actions/setup"]
    assert job("lint")["timeout-minutes"] == 10


def test_ci_typecheck_job_runs_mypy() -> None:
    lines = run_lines("typecheck")

    assert line_index(lines, "mypy app") >= 0
    assert line_index(lines, "mypy scripts") >= 0
    assert step_with_run("typecheck", "mypy app")["working-directory"] == "apps/api"
    assert "working-directory" not in step_with_run("typecheck", "mypy scripts")


def test_ci_typecheck_job_runs_vue_tsc() -> None:
    assert "just web-typecheck" in run_lines("typecheck")
    assert job("typecheck")["timeout-minutes"] == 15


def test_ci_unit_job_runs_api_and_scripts() -> None:
    lines = run_lines("unit")

    api_line = lines[line_index(lines, "pytest", '-m "not integration"')]
    assert "scripts/tests" not in api_line
    assert step_with_run("unit", api_line)["working-directory"] == "apps/api"
    assert line_index(lines, "pytest scripts/tests") >= 0
    assert job("unit")["timeout-minutes"] == 15


def test_ci_unit_job_has_no_db() -> None:
    for line in run_lines("unit"):
        assert "docker compose" not in line
        assert "db-reset" not in line


def test_ci_integration_job_order() -> None:
    lines = run_lines("integration")

    up = line_index(lines, "docker compose", "up")
    reset = lines.index("just db-reset --yes")
    api_tests = line_index(lines, "pytest -m integration")
    assert up < reset < api_tests
    assert job("integration")["timeout-minutes"] == 25


def test_ci_integration_job_waits_for_services() -> None:
    lines = run_lines("integration")

    up_line = lines[line_index(lines, "docker compose", "up")]
    assert "--wait" in up_line
    assert up_line.split().count("db") == 1
    assert up_line.split().count("storage") == 1


def test_ci_integration_job_tears_down_always() -> None:
    last = steps_of("integration")[-1]

    assert last["if"] == "always()"
    assert "docker compose" in last["run"]
    assert "down" in last["run"]


def test_ci_integration_job_runs_scripts_integration() -> None:
    assert line_index(run_lines("integration"), "pytest scripts/tests -m integration") >= 0


def test_ci_db_checks_job_order() -> None:
    lines = run_lines("db-checks")

    reset = lines.index("just db-reset --yes")
    heads = line_index(lines, "alembic heads")
    drift = lines.index("just schema-drift")
    assert reset < heads < drift
    assert job("db-checks")["timeout-minutes"] == 20


def test_ci_db_checks_single_head() -> None:
    lines = run_lines("db-checks")

    heads_line = lines[line_index(lines, "alembic heads")]
    assert "wc -l" in heads_line
    assert "-eq 1" in heads_line


def test_ci_db_checks_job_tears_down_always() -> None:
    last = steps_of("db-checks")[-1]

    assert last["if"] == "always()"
    assert "docker compose" in last["run"]
    assert "down" in last["run"]


def test_ci_web_test_job_runs_vitest() -> None:
    step = step_with_run("web-test", "vitest run")

    assert step["working-directory"] == "apps/web"
    assert job("web-test")["timeout-minutes"] == 15


def test_ci_web_test_job_skips_python() -> None:
    setup = [s for s in steps_of("web-test") if s.get("uses") == "./.github/actions/setup"]

    assert len(setup) == 1
    assert setup[0]["with"]["python"] is False


def test_ci_web_build_job_checks_after_build() -> None:
    lines = run_lines("web-build")

    build = line_index(lines, "vite build")
    check = line_index(lines, "check_parent_bundle.mjs")
    assert build < check
    assert job("web-build")["timeout-minutes"] == 10
    for needle in ("vite build", "check_parent_bundle.mjs"):
        assert step_with_run("web-build", needle)["working-directory"] == "apps/web"


def test_ci_web_build_job_skips_python() -> None:
    setup = [s for s in steps_of("web-build") if s.get("uses") == "./.github/actions/setup"]

    assert len(setup) == 1
    assert setup[0]["with"]["python"] is False


E2E_YML = "e2e.yml"


def test_e2e_workflow_triggers() -> None:
    on = triggers(E2E_YML)

    assert "workflow_dispatch" in on
    assert on["schedule"][0]["cron"] == "0 18 * * *"
    assert "pull_request" not in on
    assert "push" not in on
    assert workflow(E2E_YML)["permissions"] == {"contents": "read"}
    assert job("e2e", E2E_YML)["timeout-minutes"] == 30


def test_e2e_workflow_order() -> None:
    lines = run_lines("e2e", E2E_YML)

    up = line_index(lines, "docker compose", "up")
    reset = lines.index("just db-reset --yes")
    dev_up = line_index(lines, "dev_up.sh")
    playwright = line_index(lines, "playwright test")
    assert up < reset < dev_up < playwright
    assert line_index(lines, "DEV_UP_SKIP_DB=1", "dev_up.sh") == dev_up


def test_e2e_workflow_uploads_report_on_failure() -> None:
    uploads = [
        s
        for s in steps_of("e2e", E2E_YML)
        if str(s.get("uses", "")).startswith("actions/upload-artifact")
    ]

    assert len(uploads) == 1
    assert uploads[0]["if"] == "failure()"
    assert "playwright-report" in uploads[0]["with"]["path"]
    assert "test-results" in uploads[0]["with"]["path"]
    assert uploads[0]["with"]["retention-days"] == 7


def test_e2e_workflow_tears_down_always() -> None:
    last = steps_of("e2e", E2E_YML)[-1]

    assert last["if"] == "always()"
    assert "dev_down.sh --all" in last["run"]


def test_e2e_workflow_generates_secret() -> None:
    lines = run_lines("e2e", E2E_YML)

    secret_lines = [line for line in lines if "APP_SECRET_KEY" in line]
    assert any("openssl rand" in line for line in secret_lines)
    fixed = re.compile(r"APP_SECRET_KEY\s*[=:]\s*['\"]?[A-Za-z0-9]")
    assert [line for line in lines if fixed.search(line)] == []


def test_e2e_workflow_no_supabase() -> None:
    text = (WORKFLOWS / E2E_YML).read_text(encoding="utf-8")

    assert "supabase" not in text.lower()


def steps_using(name: str, prefix: str, file: str = "ci.yml") -> list[dict[str, Any]]:
    return [s for s in steps_of(name, file) if str(s.get("uses", "")).startswith(prefix)]


def docker_build_contexts() -> list[str]:
    """docker-build job 建置的 context（`docker build` 最後一個參數或 action 的 context）。"""
    contexts: list[str] = []
    for line in run_lines("docker-build"):
        if "docker build" in line:
            contexts.append(line.split()[-1])
    for step in steps_using("docker-build", "docker/build-push-action"):
        contexts.append(str(step["with"]["context"]))
    return [c.removeprefix("./") for c in contexts]


def test_ci_docker_build_job_builds_both_images() -> None:
    assert sorted(docker_build_contexts()) == ["apps/api", "apps/web"]
    assert job("docker-build")["timeout-minutes"] == 20


def test_ci_docker_build_job_uses_buildx_gha_cache() -> None:
    assert steps_using("docker-build", "docker/setup-buildx-action")
    builds = steps_using("docker-build", "docker/build-push-action")

    assert len(builds) == 2
    for build in builds:
        assert build["with"]["cache-from"].startswith("type=gha")
        assert build["with"]["load"] is True


def test_ci_docker_build_job_smoke_checks() -> None:
    text = "\n".join(run_lines("docker-build")).lower()

    for needle in ("/healthz", "/parent/", "content-security-policy", "import app", "backend_url="):
        assert needle in text, needle
    assert "18080:8080" in text


def test_ci_docker_build_job_removes_containers_always() -> None:
    last = steps_of("docker-build")[-1]

    assert last["if"] == "always()"
    assert "docker rm" in last["run"]


def test_ci_docker_build_job_never_pushes() -> None:
    assert not [line for line in run_lines("docker-build") if "docker push" in line]
    for step in steps_using("docker-build", "docker/build-push-action"):
        assert step["with"].get("push") in (None, False)


def test_e2e_workflow_uploads_service_logs_on_failure() -> None:
    uploads = [
        s
        for s in steps_using("e2e", "actions/upload-artifact", E2E_YML)
        if "failure()" in str(s.get("if"))
    ]

    assert len(uploads) == 1
    assert "var/log/" in uploads[0]["with"]["path"]


def test_ci_docker_build_job_cleanup_tolerates_missing_container() -> None:
    cleanup = [s for s in steps_of("docker-build") if "always()" in str(s.get("if"))]

    assert len(cleanup) == 1
    assert "docker rm -f" in cleanup[0]["run"]
    assert "|| true" in cleanup[0]["run"]


# --- INFRA-055：e2e workflow 建立 e2e admin、Playwright testMatch 只收 spec ---------------------

E2E_ADMIN_SCRIPT = REPO_ROOT / "scripts" / "e2e_bootstrap_admin.sh"
WEB_DIR = REPO_ROOT / "apps" / "web"
PLAYWRIGHT_CONFIG = WEB_DIR / "playwright.config.ts"
# 密碼變數的展開（只提到變數名稱的錯誤訊息不算印出密碼）
PASSWORD_VARS = (
    "$E2E_ADMIN_PASSWORD",
    "${E2E_ADMIN_PASSWORD}",
    "$pass",
    "${pass}",
    "$INITIAL_PASSWORD",
    "${INITIAL_PASSWORD}",
)


def step_index(steps: list[dict[str, Any]], needle: str) -> int:
    for index, step in enumerate(steps):
        if needle in str(step.get("run", "")):
            return index
    raise AssertionError(f"找不到 run 含 {needle!r} 的 step")


def bootstrap_step_index(steps: list[dict[str, Any]]) -> int:
    for index, step in enumerate(steps):
        run = str(step.get("run", ""))
        if "create-admin" in run or E2E_ADMIN_SCRIPT.name in run:
            return index
    raise AssertionError("找不到建立 e2e admin 的 step")


def test_e2e_workflow_bootstraps_admin() -> None:
    steps = steps_of("e2e", E2E_YML)

    assert (
        step_index(steps, "dev_up.sh")
        < bootstrap_step_index(steps)
        < step_index(steps, "playwright test")
    )


def test_e2e_workflow_playwright_env_has_admin_credentials() -> None:
    steps = steps_of("e2e", E2E_YML)
    playwright = steps[step_index(steps, "playwright test")]
    env = playwright.get("env", {})

    for key in ("E2E_ADMIN_USERNAME", "E2E_ADMIN_PASSWORD"):
        assert re.fullmatch(r"\$\{\{\s*env\." + key + r"\s*\}\}", str(env.get(key, ""))), env
    # 前一步以 $GITHUB_ENV 寫入，值由 openssl rand 產生
    generate = [
        s
        for s in steps[: step_index(steps, "playwright test")]
        if "E2E_ADMIN_PASSWORD=" in str(s.get("run", ""))
    ]
    assert len(generate) == 1
    assert "GITHUB_ENV" in generate[0]["run"]
    assert "openssl rand" in generate[0]["run"]
    # 不得有字面密碼
    literal = re.compile(r"E2E_ADMIN_PASSWORD\s*[=:]\s*['\"]?[A-Za-z0-9]")
    for text in (
        (WORKFLOWS / E2E_YML).read_text(encoding="utf-8"),
        E2E_ADMIN_SCRIPT.read_text(encoding="utf-8"),
    ):
        assert [line for line in text.splitlines() if literal.search(line)] == []


def password_print_lines(text: str) -> list[str]:
    """回傳把密碼變數展開印到 stdout 的行（echo / printf）。

    不算：`::add-mask::`（遮蔽用）、只寫進 `$GITHUB_ENV` 的行、註解。
    """
    found: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not re.match(r"(echo|printf)\b", stripped):
            continue
        if "::add-mask::" in stripped or re.search(r">>?\s*\"?\$GITHUB_ENV", stripped):
            continue
        if any(var in stripped for var in PASSWORD_VARS):
            found.append(stripped)
    return found


XTRACE_PATTERNS = (
    # set -x / set -ex / set -euxo pipefail（含組合旗標）
    re.compile(r"(^|[;&|(]\s*)set\s+-[a-zA-Z]*x"),
    # set -o xtrace
    re.compile(r"(^|[;&|(]\s*)set\s+-o\s+xtrace\b"),
    # bash -x / sh -ex / shell: bash -x {0}
    re.compile(r"\b(bash|sh)\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*x"),
    # SHELLOPTS=xtrace / export SHELLOPTS
    re.compile(r"SHELLOPTS\s*=.*xtrace"),
)


def enables_xtrace(text: str) -> bool:
    """非註解行開啟 xtrace（會把展開後的密碼印進 log）即 True。"""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if any(p.search(stripped) for p in XTRACE_PATTERNS):
            return True
    return False


def e2e_run_blocks() -> list[str]:
    """e2e.yml 所有 step 的 run 與 shell，以及 job / workflow 的 defaults.run.shell。"""
    wf = workflow(E2E_YML)
    blocks: list[str] = []
    for spec in [wf, *wf["jobs"].values()]:
        shell = spec.get("defaults", {}).get("run", {}).get("shell")
        if shell:
            blocks.append(f"shell: {shell}")
    for step in steps_of("e2e", E2E_YML):
        if step.get("shell"):
            blocks.append(f"shell: {step['shell']}")
        if step.get("run"):
            blocks.append(str(step["run"]))
    return blocks


def test_e2e_workflow_bootstrap_masks_password() -> None:
    steps = steps_of("e2e", E2E_YML)
    script = E2E_ADMIN_SCRIPT.read_text(encoding="utf-8")

    # 掃描對象：所有提到密碼的 run 區塊（含產生帳密那一步）、建立 admin 的 step 與腳本
    password_blocks = [b for b in e2e_run_blocks() if "PASSWORD" in b or "password" in b]
    assert password_blocks
    bootstrap = str(steps[bootstrap_step_index(steps)]["run"])
    scanned = [*password_blocks, bootstrap, script]
    assert [line for b in scanned for line in password_print_lines(b)] == []
    assert not enables_xtrace(script)
    assert not any(enables_xtrace(b) for b in e2e_run_blocks())
    generate = [s for s in steps if "E2E_ADMIN_PASSWORD=" in str(s.get("run", ""))]
    assert len(generate) == 1
    run = str(generate[0]["run"])
    assert "::add-mask::" in run
    # add-mask 必須在寫入 GITHUB_ENV 之前
    assert run.index("::add-mask::") < run.index("E2E_ADMIN_PASSWORD=")


def test_e2e_password_detector_flags_echo_in_generate_step() -> None:
    steps = steps_of("e2e", E2E_YML)
    generate = next(str(s["run"]) for s in steps if "E2E_ADMIN_PASSWORD=" in str(s.get("run", "")))

    assert password_print_lines(generate + '\necho "$password"\n') == ['echo "$password"']
    assert password_print_lines('printf "%s" "${E2E_ADMIN_PASSWORD}"') != []
    # 只提到變數名稱、寫進 GITHUB_ENV、add-mask 都不算
    assert password_print_lines('echo "缺少 E2E_ADMIN_PASSWORD" >&2') == []
    assert password_print_lines('echo "E2E_ADMIN_PASSWORD=$password" >> "$GITHUB_ENV"') == []
    assert password_print_lines('echo "::add-mask::$password"') == []
    assert [line for b in e2e_run_blocks() for line in password_print_lines(b)] == []


@pytest.mark.parametrize(
    "text",
    [
        "set -x",
        "set -ex",
        "set -euxo pipefail",
        "set -o xtrace",
        "bash -x scripts/e2e_bootstrap_admin.sh",
        "sh -ex scripts/e2e_bootstrap_admin.sh",
        "shell: bash -x {0}",
        "cd apps/api && set -x",
        "export SHELLOPTS=xtrace",
    ],
)
def test_e2e_xtrace_detector_variants(text: str) -> None:
    assert enables_xtrace(text)


def test_e2e_xtrace_detector_negatives_and_current_files() -> None:
    for text in (
        "set -euo pipefail",
        "set +e",
        "# 不開 set -x",
        "bash scripts/e2e_bootstrap_admin.sh",
        "shell: bash -e {0}",
        "uv run --frozen python -m app.cli create-admin",
    ):
        assert not enables_xtrace(text), text
    assert not any(enables_xtrace(b) for b in e2e_run_blocks())
    assert not enables_xtrace(E2E_ADMIN_SCRIPT.read_text(encoding="utf-8"))


E2E_DIR = WEB_DIR / "e2e"
UI_LOGIN_FILE = E2E_DIR / "admin" / "support.spec.ts"


def e2e_sources() -> dict[str, str]:
    return {
        str(path.relative_to(E2E_DIR)): path.read_text(encoding="utf-8")
        for path in sorted(E2E_DIR.rglob("*.ts"))
    }


def test_e2e_specs_do_not_read_admin_password() -> None:
    reading = re.compile(r"env(\.|\[['\"])E2E_ADMIN_PASSWORD")
    readers = sorted(name for name, text in e2e_sources().items() if reading.search(text))

    assert set(readers) <= {"support/global-setup.ts", "admin/support.spec.ts"}
    assert "support/global-setup.ts" in readers


def describe_blocks(text: str) -> list[str]:
    """以括號配對取出每個 test.describe(...) 呼叫的完整文字。"""
    blocks: list[str] = []
    for match in re.finditer(r"test\.describe\(", text):
        depth = 0
        for index in range(match.end() - 1, len(text)):
            if text[index] == "(":
                depth += 1
            elif text[index] == ")":
                depth -= 1
                if depth == 0:
                    blocks.append(text[match.start() : index + 1])
                    break
    return blocks


def test_e2e_ui_login_describe_has_trace_off() -> None:
    form = "getByPlaceholder('請輸入密碼')"
    files = sorted(name for name, text in e2e_sources().items() if form in text)

    assert files == ["admin/support.spec.ts"]
    text = UI_LOGIN_FILE.read_text(encoding="utf-8")
    helper = re.search(r"async function (\w+)\([^)]*\)[^{]*\{[^}]*" + re.escape(form), text)
    assert helper, "UI 登入 helper 必須是同檔的具名函式"
    callers = [b for b in describe_blocks(text) if f"{helper.group(1)}(" in b]
    assert callers
    for block in callers:
        assert "test.use({ trace: 'off' })" in block


def test_playwright_config_test_match_static() -> None:
    text = PLAYWRIGHT_CONFIG.read_text(encoding="utf-8")
    matches = re.findall(r"testMatch:\s*\[([^\]]*)\]", text)

    assert len(matches) == 2
    patterns = [p for group in matches for p in re.findall(r"'([^']+)'", group)]
    assert sorted(patterns) == [
        "e2e/admin/**/*.spec.ts",
        "e2e/parent/**/*.spec.ts",
        "e2e/smoke.spec.ts",
    ]


@pytest.mark.skipif(
    not (WEB_DIR / "node_modules" / "@playwright" / "test").is_dir()
    or shutil.which("pnpm") is None,
    reason="需要 apps/web/node_modules 的 Playwright 與 pnpm（CI 的 unit job 不裝 node）",
)
def test_playwright_config_test_match_only_specs() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("E2E_")}
    pnpm = shutil.which("pnpm")
    assert pnpm is not None
    # 固定指令、無外部輸入
    result = subprocess.run(  # noqa: S603
        [pnpm, "exec", "playwright", "test", "--list"],
        cwd=WEB_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    output = result.stdout + result.stderr

    assert result.returncode == 0, output
    assert "should not import test file" not in output
    assert "parent/login-bind-pickup.spec.ts" in output
    assert "admin/support.spec.ts" in output
    # list reporter 每列：[project] <U+203A> <檔案>:<行>:<欄> <U+203A> <標題>
    files = set(re.findall(r"\u203a\s+(\S+?):\d+:\d+", output))
    assert files
    assert [f for f in files if not f.endswith(".spec.ts")] == []


def test_vite_config_prebundles_element_plus_styles() -> None:
    """unplugin 依「這次用到的元件」才 import element-plus 樣式：冷快取時進新頁面才發現新依賴，
    vite 重新預打包並整頁重載，打斷 e2e 換頁。dev server 啟動時就要預打包全部元件樣式。"""
    config = (WEB_DIR / "vite.config.ts").read_text(encoding="utf-8")

    assert re.search(r"optimizeDeps:\s*\{\s*include:\s*\[\s*\.\.\.OPTIMIZE_DEPS_INCLUDE", config)
    assert "from './build/optimizeDeps.ts'" in config


@pytest.mark.skipif(
    not (WEB_DIR / "node_modules" / "element-plus").is_dir() or shutil.which("node") is None,
    reason="需要 apps/web/node_modules 的 element-plus 與 node（CI 的 unit job 不裝 node）",
)
def test_vite_config_optimize_deps_lists_every_element_plus_style() -> None:
    node = shutil.which("node")
    assert node is not None
    script = (
        "import('./build/optimizeDeps.ts')"
        ".then((m) => console.log(JSON.stringify(m.OPTIMIZE_DEPS_INCLUDE)))"
    )
    # 固定指令、無外部輸入
    result = subprocess.run(  # noqa: S603
        [node, "-e", script], cwd=WEB_DIR, capture_output=True, text=True, timeout=60, check=False
    )
    assert result.returncode == 0, result.stderr
    deps = json.loads(result.stdout)

    components = WEB_DIR / "node_modules" / "element-plus" / "es" / "components"
    expected = sorted(
        f"element-plus/es/components/{d.name}/style/css"
        for d in components.iterdir()
        if (d / "style" / "css.mjs").is_file()
    )
    # e2e 實際用到、冷快取時曾觸發重載的樣式（form / table / tabs …）都要在內
    assert deps == expected
    for name in ("form", "input", "table", "date-picker", "dialog", "tabs", "radio-group"):
        assert f"element-plus/es/components/{name}/style/css" in deps
