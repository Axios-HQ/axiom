"""Tests for code-server integration in SandboxSupervisor."""

import os
import string
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_supervisor(env_vars: dict):
    """Create a SandboxSupervisor with the given env vars patched in."""
    with patch.dict(os.environ, env_vars, clear=False):
        from src.sandbox.entrypoint import SandboxSupervisor

        return SandboxSupervisor()


@pytest.fixture
def base_env():
    """Minimal env vars for SandboxSupervisor construction."""
    return {
        "SANDBOX_ID": "test-sandbox",
        "REPO_OWNER": "acme",
        "REPO_NAME": "my-repo",
        "SESSION_CONFIG": '{"session_id": "sess-abc123"}',
        "CONTROL_PLANE_URL": "https://cp.example.com",
        "SANDBOX_AUTH_TOKEN": "tok-secret",
    }


@pytest.fixture
def code_server_env(base_env):
    """Env vars with code-server enabled."""
    return {**base_env, "CODE_SERVER_ENABLED": "true"}


# ──────────────────────────────────────────────────────────────────────────────
# Password generation
# ──────────────────────────────────────────────────────────────────────────────


class TestGenerateCodeServerPassword:
    def test_returns_32_char_string(self, base_env):
        supervisor = _make_supervisor(base_env)
        password = supervisor._generate_code_server_password()
        assert len(password) == 32

    def test_only_alphanumeric_characters(self, base_env):
        supervisor = _make_supervisor(base_env)
        password = supervisor._generate_code_server_password()
        allowed = set(string.ascii_letters + string.digits)
        assert all(c in allowed for c in password), f"Unexpected chars in password: {password!r}"

    def test_two_passwords_differ(self, base_env):
        """Each call should produce a unique password (with overwhelming probability)."""
        supervisor = _make_supervisor(base_env)
        p1 = supervisor._generate_code_server_password()
        p2 = supervisor._generate_code_server_password()
        assert p1 != p2

    @pytest.mark.asyncio
    async def test_password_stored_on_start(self, code_server_env, tmp_path):
        """start_code_server must store the generated password before launching the process."""
        supervisor = _make_supervisor(code_server_env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"

        def _fake_generate():
            return "FixedPassword1234567890123456789"  # exactly 32 chars

        supervisor._generate_code_server_password = _fake_generate
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._report_code_server_ready = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process),
            patch("asyncio.create_task"),
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            await supervisor.start_code_server()

        assert supervisor._code_server_password == "FixedPassword1234567890123456789"


# ──────────────────────────────────────────────────────────────────────────────
# start_code_server — feature flag
# ──────────────────────────────────────────────────────────────────────────────


class TestStartCodeServerEnabled:
    @pytest.mark.asyncio
    async def test_skips_when_not_enabled(self, base_env):
        """If CODE_SERVER_ENABLED is absent, start_code_server should be a no-op."""
        supervisor = _make_supervisor(base_env)
        supervisor._generate_code_server_password = MagicMock()

        with (
            patch("asyncio.create_subprocess_exec") as mock_exec,
            patch.dict(os.environ, base_env, clear=False),
        ):
            await supervisor.start_code_server()

        mock_exec.assert_not_called()
        assert supervisor._code_server_password is None

    @pytest.mark.asyncio
    async def test_skips_when_explicitly_false(self, base_env):
        env = {**base_env, "CODE_SERVER_ENABLED": "false"}
        supervisor = _make_supervisor(env)

        with (
            patch("asyncio.create_subprocess_exec") as mock_exec,
            patch.dict(os.environ, env, clear=False),
        ):
            await supervisor.start_code_server()

        mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_starts_when_enabled_true(self, code_server_env, tmp_path):
        """When CODE_SERVER_ENABLED=true a subprocess should be launched."""
        supervisor = _make_supervisor(code_server_env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._report_code_server_ready = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process) as mock_exec,
            patch("asyncio.create_task"),
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            await supervisor.start_code_server()

        mock_exec.assert_called_once()
        call_args = mock_exec.call_args
        assert call_args.args[0] == "code-server"

    @pytest.mark.asyncio
    async def test_starts_when_enabled_1(self, base_env, tmp_path):
        """CODE_SERVER_ENABLED=1 should also enable code-server."""
        env = {**base_env, "CODE_SERVER_ENABLED": "1"}
        supervisor = _make_supervisor(env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._report_code_server_ready = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process) as mock_exec,
            patch("asyncio.create_task"),
            patch.dict(os.environ, env, clear=False),
        ):
            await supervisor.start_code_server()

        mock_exec.assert_called_once()


# ──────────────────────────────────────────────────────────────────────────────
# start_code_server — config file
# ──────────────────────────────────────────────────────────────────────────────


class TestStartCodeServerConfigFile:
    @pytest.mark.asyncio
    async def test_config_file_contains_password_and_port(self, code_server_env, tmp_path):
        """The config.yaml written for code-server must include the password and port."""
        supervisor = _make_supervisor(code_server_env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._report_code_server_ready = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process),
            patch("asyncio.create_task"),
            patch("pathlib.Path.mkdir"),
            patch("pathlib.Path.write_text") as mock_write,
            patch("pathlib.Path.chmod"),
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            await supervisor.start_code_server()

        mock_write.assert_called_once()
        written_content = mock_write.call_args.args[0]
        assert "password:" in written_content
        assert str(supervisor.CODE_SERVER_PORT) in written_content
        assert "auth: password" in written_content

    @pytest.mark.asyncio
    async def test_config_file_does_not_expose_password_via_cli_args(
        self, code_server_env, tmp_path
    ):
        """Password must be in the config file, NOT passed as a CLI argument."""
        supervisor = _make_supervisor(code_server_env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._report_code_server_ready = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process) as mock_exec,
            patch("asyncio.create_task"),
            patch("pathlib.Path.mkdir"),
            patch("pathlib.Path.write_text"),
            patch("pathlib.Path.chmod"),
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            await supervisor.start_code_server()

        call_args = mock_exec.call_args
        cli_args = list(call_args.args)
        # The password must NOT appear as a positional CLI arg
        password = supervisor._code_server_password
        assert password not in cli_args, "Password must not be passed as a CLI argument"


# ──────────────────────────────────────────────────────────────────────────────
# _report_code_server_ready
# ──────────────────────────────────────────────────────────────────────────────


class TestReportCodeServerReady:
    @pytest.mark.asyncio
    async def test_posts_to_correct_endpoint(self, code_server_env):
        """Should POST to /sessions/<id>/code-server-ready with url and password."""
        supervisor = _make_supervisor(code_server_env)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)

        with (
            patch("httpx.AsyncClient") as mock_cls,
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            await supervisor._report_code_server_ready(
                "https://code.example.com", "testpassword123"
            )

        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args
        assert "/sessions/sess-abc123/code-server-ready" in call_kwargs.args[0]

        payload = call_kwargs.kwargs["json"]
        assert payload["url"] == "https://code.example.com"
        assert payload["password"] == "testpassword123"
        assert payload["sandboxId"] == "test-sandbox"

    @pytest.mark.asyncio
    async def test_includes_bearer_token_in_header(self, code_server_env):
        """Authorization header must carry the sandbox token."""
        supervisor = _make_supervisor(code_server_env)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)

        with (
            patch("httpx.AsyncClient") as mock_cls,
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            await supervisor._report_code_server_ready("https://code.example.com", "pw")

        call_kwargs = mock_client.post.call_args
        headers = call_kwargs.kwargs["headers"]
        assert headers["Authorization"] == "Bearer tok-secret"

    @pytest.mark.asyncio
    async def test_skips_when_no_control_plane_url(self, base_env):
        """If CONTROL_PLANE_URL is absent, report must be a no-op (no HTTP call)."""
        env = {**base_env, "CONTROL_PLANE_URL": ""}
        supervisor = _make_supervisor(env)

        with patch("httpx.AsyncClient") as mock_cls, patch.dict(os.environ, env, clear=False):
            await supervisor._report_code_server_ready("https://code.example.com", "pw")

        mock_cls.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_when_no_session_id(self, base_env):
        """If session_id is missing from session config, report must be a no-op."""
        env = {**base_env, "SESSION_CONFIG": "{}"}
        supervisor = _make_supervisor(env)

        with patch("httpx.AsyncClient") as mock_cls, patch.dict(os.environ, env, clear=False):
            await supervisor._report_code_server_ready("https://code.example.com", "pw")

        mock_cls.assert_not_called()

    @pytest.mark.asyncio
    async def test_does_not_raise_on_http_error(self, code_server_env):
        """Network errors during reporting must not propagate (non-fatal)."""
        supervisor = _make_supervisor(code_server_env)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=Exception("network failure"))

        with (
            patch("httpx.AsyncClient") as mock_cls,
            patch.dict(os.environ, code_server_env, clear=False),
        ):
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            # Must not raise
            await supervisor._report_code_server_ready("https://code.example.com", "pw")

    @pytest.mark.asyncio
    async def test_tunnel_url_used_when_provided(self, code_server_env, tmp_path):
        """When CODE_SERVER_TUNNEL_URL is set it should be used as the URL in the report."""
        env = {**code_server_env, "CODE_SERVER_TUNNEL_URL": "https://tunnel.modal.run/cs"}
        supervisor = _make_supervisor(env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        reported_urls = []

        async def _fake_report(url, password):
            reported_urls.append(url)

        supervisor._report_code_server_ready = _fake_report

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process),
            patch("asyncio.create_task"),
            patch("pathlib.Path.mkdir"),
            patch("pathlib.Path.write_text"),
            patch("pathlib.Path.chmod"),
            patch.dict(os.environ, env, clear=False),
        ):
            await supervisor.start_code_server()

        assert reported_urls == ["https://tunnel.modal.run/cs"]

    @pytest.mark.asyncio
    async def test_localhost_fallback_when_no_tunnel_url(self, code_server_env, tmp_path):
        """When CODE_SERVER_TUNNEL_URL is absent, fall back to localhost:<port>."""
        env = {k: v for k, v in code_server_env.items() if k != "CODE_SERVER_TUNNEL_URL"}
        env.pop("CODE_SERVER_TUNNEL_URL", None)
        supervisor = _make_supervisor(env)
        supervisor.workspace_path = tmp_path
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor._wait_for_code_server_health = AsyncMock()
        supervisor._forward_code_server_logs = AsyncMock()

        reported_urls = []

        async def _fake_report(url, password):
            reported_urls.append(url)

        supervisor._report_code_server_ready = _fake_report

        mock_process = MagicMock()
        mock_process.stdout = None

        with (
            patch("asyncio.create_subprocess_exec", return_value=mock_process),
            patch("asyncio.create_task"),
            patch("pathlib.Path.mkdir"),
            patch("pathlib.Path.write_text"),
            patch("pathlib.Path.chmod"),
            patch.dict(os.environ, env, clear=False),
        ):
            await supervisor.start_code_server()

        assert len(reported_urls) == 1
        assert "localhost" in reported_urls[0]
        assert str(supervisor.CODE_SERVER_PORT) in reported_urls[0]
