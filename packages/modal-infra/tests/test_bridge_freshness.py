"""Tests for bridge branch freshness guard in _handle_push."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.bridge import AgentBridge


def _create_bridge(tmp_path: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = tmp_path
    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)
    return bridge


def _push_command(base_branch: str = "main") -> dict:
    return {
        "type": "push",
        "baseBranch": base_branch,
        "pushSpec": {
            "targetBranch": "feature/test",
            "refspec": "HEAD:refs/heads/feature/test",
            "remoteUrl": "https://token@github.com/open-inspect/repo.git",
            "redactedRemoteUrl": "https://***@github.com/open-inspect/repo.git",
            "force": False,
        },
    }


def _fake_process(returncode: int | None, communicate_result: tuple[bytes, bytes] = (b"", b"")):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=communicate_result)
    process.wait = AsyncMock(return_value=None)
    process.terminate = MagicMock()
    process.kill = MagicMock()
    return process


# ── _run_git helper ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_git_returns_stdout_and_stderr(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"
    process = _fake_process(returncode=0, communicate_result=(b"hello\n", b"warn\n"))

    with patch(
        "src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        rc, stdout, stderr = await bridge._run_git(
            ["rev-parse", "HEAD"], repo_dir, timeout_seconds=10.0
        )

    assert rc == 0
    assert stdout == "hello"
    assert stderr == "warn"


@pytest.mark.asyncio
async def test_run_git_raises_on_timeout(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"
    process = _fake_process(returncode=None)

    async def _timeout_communicate():
        raise TimeoutError

    process.communicate = AsyncMock(side_effect=TimeoutError)

    with (
        patch("src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)),
        patch(
            "src.sandbox.bridge.asyncio.wait_for",
            side_effect=TimeoutError,
        ),
        pytest.raises(TimeoutError),
    ):
        await bridge._run_git(["fetch"], repo_dir, timeout_seconds=5.0)


# ── _check_branch_freshness ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_check_freshness_returns_false_when_ahead_of_base(tmp_path: Path):
    """Branch is 0 commits behind base → not stale."""
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        if args[0] == "fetch":
            return 0, "", ""
        if args[0] == "rev-list":
            return 0, "0", ""
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    is_behind, count = await bridge._check_branch_freshness(repo_dir, "main", "https://url")

    assert is_behind is False
    assert count == 0


@pytest.mark.asyncio
async def test_check_freshness_returns_true_when_behind_base(tmp_path: Path):
    """Branch is 3 commits behind base → stale."""
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        if args[0] == "fetch":
            return 0, "", ""
        if args[0] == "rev-list":
            return 0, "3", ""
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    is_behind, count = await bridge._check_branch_freshness(repo_dir, "main", "https://url")

    assert is_behind is True
    assert count == 3


@pytest.mark.asyncio
async def test_check_freshness_returns_false_on_fetch_failure(tmp_path: Path):
    """Fetch failure → optimistic pass-through (don't block push)."""
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        if args[0] == "fetch":
            return 1, "", "fatal: authentication failed"
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    is_behind, count = await bridge._check_branch_freshness(repo_dir, "main", "https://url")

    assert is_behind is False
    assert count == 0


@pytest.mark.asyncio
async def test_check_freshness_returns_false_on_fetch_timeout(tmp_path: Path):
    """Fetch timeout → optimistic pass-through."""
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        if args[0] == "fetch":
            raise TimeoutError
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    is_behind, count = await bridge._check_branch_freshness(repo_dir, "main", "https://url")

    assert is_behind is False
    assert count == 0


# ── _attempt_rebase_onto_base ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rebase_returns_success_when_clean(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    ok, err = await bridge._attempt_rebase_onto_base(repo_dir)

    assert ok is True
    assert err is None


@pytest.mark.asyncio
async def test_rebase_aborts_and_returns_error_on_conflict(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "repo"
    calls: list[list[str]] = []

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        calls.append(list(args))
        if args[0] == "rebase" and args[1] != "--abort":
            return 1, "", "CONFLICT (content): Merge conflict"
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    ok, err = await bridge._attempt_rebase_onto_base(repo_dir)

    assert ok is False
    assert err is not None
    assert "CONFLICT" in err
    # Abort must have been called
    assert any(c == ["rebase", "--abort"] for c in calls)


@pytest.mark.asyncio
async def test_rebase_handles_timeout(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge.GIT_REBASE_TIMEOUT_SECONDS = 30.0
    repo_dir = tmp_path / "repo"
    calls: list[list[str]] = []

    async def mock_run_git(args, cwd, timeout_seconds, env=None):
        calls.append(list(args))
        if args[0] == "rebase" and args[1] != "--abort":
            raise TimeoutError
        return 0, "", ""

    bridge._run_git = mock_run_git  # type: ignore[method-assign]

    ok, err = await bridge._attempt_rebase_onto_base(repo_dir)

    assert ok is False
    assert err is not None
    assert "30s" in err
    # Abort still attempted after timeout
    assert any(c == ["rebase", "--abort"] for c in calls)


# ── _handle_push with freshness guard ───────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_push_fresh_branch_skips_rebase(tmp_path: Path):
    """Branch is current → no rebase, push proceeds normally."""
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()

    async def mock_check_freshness(repo_dir, base_branch, push_url):
        return False, 0

    bridge._check_branch_freshness = mock_check_freshness  # type: ignore[method-assign]
    bridge._attempt_rebase_onto_base = AsyncMock()

    process = _fake_process(returncode=0)
    with patch(
        "src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    # No rebase called
    bridge._attempt_rebase_onto_base.assert_not_awaited()

    # push_complete sent
    sent = bridge._send_event.await_args_list
    assert len(sent) == 1
    assert sent[0].args[0]["type"] == "push_complete"


@pytest.mark.asyncio
async def test_handle_push_behind_branch_rebases_then_pushes(tmp_path: Path):
    """Branch is behind → rebase succeeds → push proceeds."""
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()

    async def mock_check_freshness(repo_dir, base_branch, push_url):
        return True, 2

    async def mock_rebase(repo_dir):
        return True, None

    bridge._check_branch_freshness = mock_check_freshness  # type: ignore[method-assign]
    bridge._attempt_rebase_onto_base = mock_rebase  # type: ignore[method-assign]

    process = _fake_process(returncode=0)
    with patch(
        "src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    # push_complete sent
    sent = bridge._send_event.await_args_list
    assert len(sent) == 1
    assert sent[0].args[0]["type"] == "push_complete"


@pytest.mark.asyncio
async def test_handle_push_rebase_conflict_sends_error_and_aborts_push(tmp_path: Path):
    """Branch is behind, rebase conflicts → push_error with remediation message."""
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()

    async def mock_check_freshness(repo_dir, base_branch, push_url):
        return True, 5

    async def mock_rebase(repo_dir):
        return False, "CONFLICT (content): Merge conflict in src/app.py"

    bridge._check_branch_freshness = mock_check_freshness  # type: ignore[method-assign]
    bridge._attempt_rebase_onto_base = mock_rebase  # type: ignore[method-assign]

    with patch("src.sandbox.bridge.asyncio.create_subprocess_exec") as mock_exec:
        await bridge._handle_push(_push_command())
        # git push should NOT be called
        mock_exec.assert_not_called()

    # push_error must be sent
    sent = bridge._send_event.await_args_list
    assert len(sent) == 1
    event = sent[0].args[0]
    assert event["type"] == "push_error"
    assert "5" in event["error"]  # behind_count included
    assert "main" in event["error"]  # base_branch named
    assert "conflicts" in event["error"]
    assert event["behindCount"] == 5
    assert event["baseBranch"] == "main"


@pytest.mark.asyncio
async def test_handle_push_no_base_branch_skips_freshness(tmp_path: Path):
    """No baseBranch in command → freshness guard skipped entirely."""
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    bridge._check_branch_freshness = AsyncMock()

    cmd = {
        "type": "push",
        # baseBranch intentionally omitted
        "pushSpec": {
            "targetBranch": "feature/test",
            "refspec": "HEAD:refs/heads/feature/test",
            "remoteUrl": "https://token@github.com/open-inspect/repo.git",
            "redactedRemoteUrl": "https://***@github.com/open-inspect/repo.git",
            "force": False,
        },
    }

    process = _fake_process(returncode=0)
    with patch(
        "src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(cmd)

    bridge._check_branch_freshness.assert_not_awaited()
    sent = bridge._send_event.await_args_list
    assert len(sent) == 1
    assert sent[0].args[0]["type"] == "push_complete"
