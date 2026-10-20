"""Exercise the pinned upstream with dummy SQLite sessions and no Telegram traffic."""
import asyncio
import importlib
import io
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

import serve


class AccountsMediaTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        self.downloads = self.root / "tmp"
        self.vault = self.root / "vault"
        self.vault.mkdir()
        self.environment = patch.dict(os.environ, {
            "TELEGRAM_API_ID": "12345", "TELEGRAM_API_HASH": "test-api-hash",
            "ASSISTANT_DATA_DIR": str(self.data), "ASSISTANT_TMP": str(self.downloads),
            "ASSISTANT_VAULT_DIR": str(self.vault),
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def discover(self):
        serve._seed_session_env()
        with patch("dotenv.load_dotenv"):
            runtime = importlib.import_module("telegram_mcp.runtime")
        clients = runtime._discover_accounts()
        self.addCleanup(lambda: [client.session.close() for client in clients.values()])
        return runtime, clients

    async def test_two_empty_sessions_are_discovered_without_bare_variable(self):
        for name in ("telegram-userbot.session", "telegram-userbot-second.session"):
            (self.data / name).touch()
        runtime, clients = self.discover()
        self.assertEqual(set(clients), {"default", "second"})
        self.assertNotIn("TELEGRAM_SESSION_NAME", os.environ)
        with patch.object(runtime, "clients", clients):
            self.assertIs(runtime.get_client("second"), clients["second"])

    async def test_single_session_keeps_legacy_environment(self):
        (self.data / "telegram-userbot.session").touch()
        runtime, clients = self.discover()
        self.assertEqual(set(clients), {"default"})
        self.assertEqual(os.environ["TELEGRAM_SESSION_NAME"], str(self.data / "telegram-userbot"))
        with patch.object(runtime, "clients", clients):
            self.assertIs(runtime.get_client(), clients["default"])

    async def test_explicit_session_filename_keeps_its_suffix(self):
        with patch.dict(os.environ, {"TELEGRAM_SESSION_FILE": str(self.data / "custom.name")}):
            serve._seed_session_env()
            self.assertEqual(os.environ["TELEGRAM_SESSION_NAME"], str(self.data / "custom.name"))

    async def test_proxy_starts_and_lists_both_empty_accounts_over_http(self):
        for name in ("telegram-userbot.session", "telegram-userbot-second.session"):
            (self.data / name).touch()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        environment = dict(os.environ, TELEGRAM_MCP_TOKEN="test-only-token", TELEGRAM_MCP_PORT=str(port))
        fixture = Path(__file__).parent / "fixtures" / "accounts_server.py"
        with (self.root / "server.log").open("w+") as logs:
            child = subprocess.Popen([sys.executable, str(fixture)], env=environment,
                                     cwd=self.root, stdout=logs, stderr=logs)
            try:
                headers = {"Authorization": "Bearer test-only-token"}
                async with httpx.AsyncClient() as http:
                    for _ in range(100):
                        try:
                            response = await http.get(f"http://127.0.0.1:{port}/healthz", headers=headers)
                            if response.status_code == 200:
                                break
                        except httpx.ConnectError:
                            pass
                        if child.poll() is not None:
                            logs.seek(0)
                            self.fail(logs.read())
                        await asyncio.sleep(0.05)
                    else:
                        self.fail("proxy did not start")
                    self.assertEqual(response.json(), {"state": "unauthorized"})
                    denied = await http.get(f"http://127.0.0.1:{port}/healthz")
                    self.assertEqual(denied.status_code, 401)
                async with streamablehttp_client(f"http://127.0.0.1:{port}/mcp", headers=headers) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool("list_accounts", {})
                        self.assertFalse(result.isError)
                        text = "\n".join(item.text for item in result.content if hasattr(item, "text"))
                        self.assertIn("default:", text)
                        self.assertIn("second:", text)
                        print(f"local proxy list_accounts:\n{text}")
            finally:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            logs.seek(0)
            output = logs.read()
            self.assertIn("аккаунты: default, second", output)
            for name in ("telegram-userbot.session", "telegram-userbot-second.session"):
                self.assertIn(f"TEST guarded {name}", output)
                self.assertGreaterEqual(output.count(f"TEST connected {name}"), 2)

    async def test_invalid_and_duplicate_default_labels_are_skipped(self):
        for label in ("UPPER", "two-words", "", "default", "два"):
            (self.data / f"telegram-userbot-{label}.session").touch()
        errors = io.StringIO()
        with redirect_stderr(errors):
            _, clients = self.discover()
        self.assertEqual(set(clients), {"default"})
        self.assertEqual(errors.getvalue().count("пропуск"), 5)

    async def test_invalid_vault_setting_fails_before_roots_are_opened(self):
        for value in ("", " ", " vault", "vault "):
            with self.subTest(value=value), patch.dict(os.environ, {"ASSISTANT_VAULT_DIR": value}), \
                 redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                serve._configure_media_roots(SimpleNamespace())

    async def test_empty_roots_allow_media_and_reject_secrets_and_escapes(self):
        runtime, clients = self.discover()
        import telegram_mcp.tools.media as media

        original_check = runtime._path_is_within_root
        original_roots = runtime.SERVER_ALLOWED_ROOTS[:]
        self.addCleanup(setattr, runtime, "_path_is_within_root", original_check)
        self.addCleanup(lambda: runtime.SERVER_ALLOWED_ROOTS.__setitem__(slice(None), original_roots))
        serve._configure_media_roots(runtime)
        self.assertEqual(runtime.SERVER_ALLOWED_ROOTS, [self.downloads, self.vault])
        context = SimpleNamespace(session=SimpleNamespace(list_roots=AsyncMock(
            return_value=SimpleNamespace(roots=[]))))
        client = clients["default"]
        message = SimpleNamespace(media=True, file=SimpleNamespace(size=146 * 1024 * 1024))

        async def download(_message, file):
            target = Path(file + ".ogg")
            target.write_bytes(b"media")
            return str(target)

        with patch.object(runtime, "clients", clients), \
             patch.object(media, "resolve_entity", AsyncMock(return_value="chat")), \
             patch.object(client, "get_messages", AsyncMock(return_value=message)), \
             patch.object(client, "download_media", AsyncMock(side_effect=download)), \
             patch.object(client, "send_file", AsyncMock()) as send:
            for directory in (self.downloads, self.vault):
                result = await media.download_media(1, 1, str(directory / "lecture.ogg"), context)
                self.assertIn("Media downloaded to", result)
                self.assertIn("File sent", await media.send_file(1, str(directory / "lecture.ogg"), ctx=context))
            for forbidden in (self.data / "telegram-userbot.session", self.data / "telegram-userbot.token",
                              self.root / ".env", self.downloads / "copy.session",
                              self.vault / "copy.token", self.downloads / ".env",
                              self.root / "outside.ogg", self.vault / "copy.session-wal"):
                forbidden.touch(exist_ok=True)
                before = send.await_count
                result = await media.send_file(1, str(forbidden), ctx=context)
                self.assertNotIn("File sent", result)
                self.assertEqual(send.await_count, before)
                result = await media.download_media(1, 1, str(forbidden), context)
                self.assertNotIn("Media downloaded to", result)
            link = self.downloads / "innocent.ogg"
            link.symlink_to(self.data / "telegram-userbot.session")
            for path in (str(link), str(self.downloads / "../data/telegram-userbot.session")):
                self.assertNotIn("File sent", await media.send_file(1, path, ctx=context))
            # Client Roots cannot widen the server's fixed boundary.
            context.session.list_roots.return_value = SimpleNamespace(roots=[SimpleNamespace(uri=self.root.as_uri())])
            self.assertNotIn("File sent", await media.send_file(1, str(self.root / ".env"), ctx=context))
            self.assertNotIn("File sent", await media.send_file(1, str(self.root / "outside.ogg"), ctx=context))
            self.assertNotIn("Album sent", await media.send_album(1, [str(self.vault / "lecture.ogg"), str(link)], ctx=context))
            self.assertIn("File sent", await media.send_file(1, str(self.vault / "lecture.ogg"), ctx=context))


if __name__ == "__main__":
    unittest.main()
