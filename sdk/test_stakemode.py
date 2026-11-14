"""Real loopback HTTP fixtures for the stdlib SDK; no browser or account data."""
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from stakemode import StakeModeClient, StakeModeError, GameBrowserClient, GameBrowserError

TOKEN_A, TOKEN_B = "A" * 43, "B" * 43


class SDKTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calls, cls.replies, cls.redirect_hits = [], [], []
        class RedirectTarget(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.redirect_hits.append(self.path)
                self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
            def log_message(self, *args): pass
        cls.target = ThreadingHTTPServer(("127.0.0.1", 0), RedirectTarget)
        class Handler(BaseHTTPRequestHandler):
            def respond(self):
                size = int(self.headers.get("Content-Length", "0"))
                cls.calls.append((self.command, self.path, dict(self.headers), self.rfile.read(size)))
                status, payload, headers = cls.replies.pop(0)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                delay = headers.pop("_fixture_delay", 0)
                for name, value in headers.items(): self.send_header(name, value)
                self.send_header("Content-Length", str(len(data))); self.end_headers()
                if delay: time.sleep(delay)
                try: self.wfile.write(data)
                except (ConnectionError, BrokenPipeError): pass
            do_GET = respond
            do_POST = respond
            do_DELETE = respond
            def log_message(self, *args): pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        for server in (cls.server, cls.target): threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.server, cls.target): server.shutdown(); server.server_close()

    def setUp(self):
        self.calls.clear(); self.replies.clear(); self.redirect_hits.clear()

    def connected(self, replies):
        self.replies.extend([(200, {"token": TOKEN_A, "snapshot": {"profiles": [{"id": "p1"}]}}, {}), *replies])
        client = StakeModeClient(timeout=1)
        # Keep production base validation fixed at 8080; transport the fixture
        # through its own ephemeral port so a running workspace is untouched.
        opener, port = client._opener, self.server.server_address[1]
        class FixtureOpener:
            def open(self, req, timeout):
                import urllib.request
                assert req.full_url.startswith("http://127.0.0.1:8080/")
                target = urllib.request.Request(req.full_url.replace("127.0.0.1:8080/", f"127.0.0.1:{port}/", 1), data=req.data, headers=dict(req.headers), method=req.method)
                return opener.open(target, timeout=timeout)
        client._opener = FixtureOpener()
        self.assertEqual(client.connect(), {"profiles": [{"id": "p1"}]})
        return client

    def test_headers_and_memory_only_token(self):
        client = self.connected([(200, {"snapshot": {"profiles": [{"id": "p1"}]}}, {})])
        self.assertEqual(client.list_profiles(), [{"id": "p1"}])
        self.assertNotIn(TOKEN_A, repr(client))
        for _, path, headers, _ in self.calls:
            self.assertEqual(headers["X-Stakemode-Workspace"], "1")
            self.assertNotIn(TOKEN_A, path)
        self.assertNotIn("Authorization", self.calls[0][2])
        self.assertEqual(self.calls[1][2]["Authorization"], f"Bearer {TOKEN_A}")
        client.disconnect()
        with self.assertRaises(StakeModeError): client.jobs()
        self.assertEqual(len(self.calls), 2)

    def test_get_refresh_once_and_no_duplicate_mutation(self):
        client = self.connected([(401, {"error": "private-token"}, {}), (200, {"token": TOKEN_B, "snapshot": {}}, {}), (200, {"jobs": []}, {}), (401, {"error": "private-password"}, {})])
        self.assertEqual(client.jobs(), {"jobs": []})
        with self.assertRaises(StakeModeError) as caught: client.start("p1")
        self.assertEqual(caught.exception.status, 401)
        self.assertNotIn("private-password", str(caught.exception))
        self.assertEqual(sum(call[0] == "POST" for call in self.calls), 1)
        with self.assertRaises(StakeModeError): client.start("p1")
        self.assertEqual(len(self.calls), 5)

    def test_native_urllib_does_not_forward_redirect_credentials(self):
        port = self.target.server_address[1]
        client = self.connected([(302, b"redirect-secret", {"Location": f"http://127.0.0.1:{port}/capture?token=private"})])
        with self.assertRaises(StakeModeError) as caught: client.jobs()
        self.assertEqual(caught.exception.status, 302)
        self.assertNotIn("redirect-secret", str(caught.exception)); self.assertNotIn("capture", str(caught.exception))
        self.assertEqual(self.redirect_hits, [])
        self.assertEqual(len(self.calls), 2)

    def test_bounded_body_errors_and_unsafe_routes(self):
        client = self.connected([(200, b"x" * (1024 * 1024 + 1), {})])
        with self.assertRaises(StakeModeError) as caught: client.jobs()
        self.assertEqual(caught.exception.code, "PROTOCOL")
        for path in ("snapshot?token=private", "../ui/api/health", "profiles/p1/%2e%2e", "cdp", "https://evil.test", "jobs/id/output?format=csv&token=private"):
            with self.assertRaises(StakeModeError): client.request("GET", path)
        with self.assertRaises(StakeModeError): client.create_profiles({"notes": "secret" * 200000})
        self.assertEqual(len(self.calls), 2)

    def test_native_socket_body_timeout_is_bounded(self):
        client = self.connected([(200, {"jobs": []}, {"_fixture_delay": 0.3})])
        client.timeout = 0.1
        at = time.monotonic()
        with self.assertRaises(StakeModeError) as caught: client.jobs()
        self.assertEqual(caught.exception.code, "TIMEOUT")
        self.assertLess(time.monotonic() - at, 0.8)

    def test_custom_desktop_screen_uses_authenticated_profile_route(self):
        client = self.connected([(200, {"profile": {"id": "p1", "screenWidth": 1473, "screenHeight": 913}}, {})])
        result = client.set_screen("p1", 1473, 913)
        self.assertEqual(result["profile"]["screenWidth"], 1473)
        method, path, headers, body = self.calls[1]
        self.assertEqual((method, path), ("POST", "/workspace/api/profiles/p1/screen"))
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN_A}")
        self.assertEqual(json.loads(body), {"width": 1473, "height": 913})

    def test_gamebrowser_alias_and_profile_ids_match_store_grammar(self):
        self.assertIs(GameBrowserClient, StakeModeClient)
        self.assertIs(GameBrowserError, StakeModeError)
        profile_id = "A" + "b" * 127
        client = self.connected([(200, {"ok": True}, {})])
        client.browser_state(profile_id)
        self.assertEqual(self.calls[-1][1], f"/workspace/api/profiles/{profile_id}/browser")
        for unsafe in ("A" * 129, "_leading", "-leading", "CON", "con", "PrN", "AUX", "NUL", "COM1", "lpt9", "../escape"):
            with self.assertRaises(StakeModeError): client.start(unsafe)
            with self.assertRaises(StakeModeError): client.request("GET", f"profiles/{unsafe}/browser")
        self.assertEqual(len(self.calls), 2)

    def test_following_and_proxy_helpers_use_local_management_api(self):
        client = self.connected([(200, {}, {}) for _ in range(7)])
        client.sync_status(); client.follow("admin", ["follower"], True)
        client.save_session(); client.resume_session(); client.stop_following()
        client.proxies(); client.import_proxies({"text": "http://127.0.0.1:9000"})
        self.assertEqual([call[1] for call in self.calls[1:]], ["/workspace/api/" + route for route in ("sync", "sync", "sync", "sync", "sync", "proxies", "proxies/import")])
        self.assertEqual(json.loads(self.calls[2][3]), {"adminId": "admin", "followerIds": ["follower"], "saveSession": True})

    def test_invalid_bases_and_server_error_redaction(self):
        for base in ("https://127.0.0.1:8080", "http://localhost:8080", "http://127.0.0.1:80", "http://user:secret@127.0.0.1:8080", "http://127.0.0.1:8080/?token=secret"):
            with self.assertRaises(StakeModeError) as caught: StakeModeClient(base)
            self.assertNotIn("secret", str(caught.exception))
        client = self.connected([(400, {"error": "cookie=private"}, {})])
        with self.assertRaises(StakeModeError) as caught: client.browser_state("p1")
        self.assertNotIn("cookie=private", str(caught.exception))


if __name__ == "__main__": unittest.main()
