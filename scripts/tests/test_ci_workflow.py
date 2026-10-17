"""CI workflow 結構測試（INFRA-022 起，後續每個 CI job task 在此檔加自己的測試）。

helper：
- `workflow(file)`：載入 .github/workflows/<file>（預設 ci.yml）。
- `job(name, file)`：取得指定 job 的 dict。
- `run_lines(name, file)`：展開該 job 所有 step 的 `run`（多行 run 拆成逐行、去掉前後空白）。
"""

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
# 密碼變數名（workflow 與腳本共用）
PASSWORD_VARS = (
    "E2E_ADMIN_PASSWORD",
    "$pass",
    "${pass}",
    "$password",
    "${password}",
    "INITIAL_PASSWORD",
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


def _echoes_password(line: str) -> bool:
    stripped = line.strip()
    if not re.match(r"(echo|printf)\b", stripped):
        return False
    if "::add-mask::" in stripped:
        return False
    # 只寫進檔案（>> "$GITHUB_ENV"）不算印到 stdout
    if re.search(r">>?\s*\"?\$GITHUB_ENV", stripped):
        return False
    return any(var in stripped for var in PASSWORD_VARS)


def test_e2e_workflow_bootstrap_masks_password() -> None:
    steps = steps_of("e2e", E2E_YML)
    bootstrap = str(steps[bootstrap_step_index(steps)]["run"])
    script = E2E_ADMIN_SCRIPT.read_text(encoding="utf-8")

    assert [
        line for line in (bootstrap + "\n" + script).splitlines() if _echoes_password(line)
    ] == []
    assert "set -x" not in script
    generate = [s for s in steps if "E2E_ADMIN_PASSWORD=" in str(s.get("run", ""))]
    assert len(generate) == 1
    run = str(generate[0]["run"])
    assert "::add-mask::" in run
    # add-mask 必須在寫入 GITHUB_ENV 之前
    assert run.index("::add-mask::") < run.index("E2E_ADMIN_PASSWORD=")


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
