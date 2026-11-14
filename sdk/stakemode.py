"""Dependency-free GameBrowser loopback REST client with StakeMode aliases."""
from __future__ import annotations

import json
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

_MAX_BYTES = 1024 * 1024
_ID = r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}"
_DEVICE_NAME = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.I)
_ROUTES = re.compile(rf"^(?:snapshot|bulk|start|stop|kill|manual|pause|role|navigate|policy|settings|batch|sync|proxies(?:/(?:import|{_ID}(?:/assign)?))?|library(?:/(?:profiles/{_ID}|groups(?:/{_ID})?|import|export))?|extensions(?:/(?:import|{_ID}))?|profiles/{_ID}(?:/(?:browser|network|screen|cookies|rename|copy|extensions(?:/{_ID}(?:/open)?)?))?|workflows(?:/(?:import|{_ID}(?:/(?:run|export))?))?|jobs(?:/{_ID}(?:/(?:cancel|output))?)?|schedules(?:/{_ID})?)$")
_MESSAGES = {"CONFIG": "Invalid local StakeMode client configuration or request", "AUTH_REQUIRED": "StakeMode authorization expired; call connect() before another write", "TIMEOUT": "Local StakeMode request timed out", "TRANSPORT": "Could not reach the local StakeMode service", "PROTOCOL": "Local StakeMode response is invalid or exceeds its limit", "HTTP": "Local StakeMode request was rejected"}


class StakeModeError(Exception):
    """Contains only a fixed diagnostic code and optional HTTP status."""
    def __init__(self, code: str, status: int | None = None):
        self.code, self.status = code, status
        super().__init__(_MESSAGES[code])


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(_ID, value) or _DEVICE_NAME.fullmatch(value):
        raise StakeModeError("CONFIG")
    return value


def _validate(method: str, path: str, body: dict | None) -> None:
    if method not in ("GET", "POST", "DELETE") or not isinstance(path, str) or len(path) > 8192:
        raise StakeModeError("CONFIG")
    if body is not None and (not isinstance(body, dict) or method == "GET"):
        raise StakeModeError("CONFIG")
    parts = path.split("?")
    pathname = parts[0]
    if len(parts) > 2 or re.search(r"[#\\%\x00-\x20\x7f]", pathname) or not _ROUTES.fullmatch(pathname):
        raise StakeModeError("CONFIG")
    profile = re.match(r"^(?:library/)?profiles/([^/]+)(?:/|$)", pathname)
    if profile:
        _identifier(profile.group(1))
    if len(parts) == 2:
        params = urllib.parse.parse_qsl(parts[1], keep_blank_values=True)
        if len(params) != 1:
            raise StakeModeError("CONFIG")
        key, value = params[0]
        if pathname == "library/export" and key == "ids":
            values = value.split(",")
            if not 1 <= len(values) <= 256:
                raise StakeModeError("CONFIG")
            for item in values:
                _identifier(item)
        elif re.fullmatch(rf"jobs/{_ID}/output", pathname) and key == "format" and value in ("json", "csv"):
            pass
        elif re.fullmatch(rf"profiles/{_ID}/cookies", pathname) and key == "origin":
            try:
                url = urllib.parse.urlsplit(value)
                valid = not (url.username or url.password or url.query or url.fragment) and url.path in ("", "/") and (url.scheme == "https" or (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))) and bool(url.hostname)
                url.port  # Reject malformed ports before sending any credential.
            except (TypeError, ValueError):
                valid = False
            if not valid:
                raise StakeModeError("CONFIG")
        else:
            raise StakeModeError("CONFIG")


class StakeModeClient:
    """Explicit connect(), memory-only token, fixed loopback service, no redirects.

    Successful methods return the server's JSON wrapper. No method writes files,
    launches a remote browser, evaluates JavaScript or exposes native owner data.
    """
    def __init__(self, base_url: str = "http://127.0.0.1:8080", timeout: float = 30.0):
        if not isinstance(base_url, str) or not re.fullmatch(r"http://127\.0\.0\.1:8080/?", base_url):
            raise StakeModeError("CONFIG")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0.1 <= timeout <= 60:
            raise StakeModeError("CONFIG")
        self.base_url, self.timeout = "http://127.0.0.1:8080", float(timeout)
        self._token: str | None = None
        self._lock = threading.RLock()
        # Ignore environment proxies: control credentials never leave loopback.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def __repr__(self) -> str:
        return "StakeModeClient(loopback=True)"

    def connect(self) -> dict[str, Any]:
        with self._lock:
            self._token = None
            result = self._send("GET", "bootstrap")
            token, snapshot = result.get("token"), result.get("snapshot")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token) or not isinstance(snapshot, dict):
                raise StakeModeError("PROTOCOL")
            self._token = token
            return snapshot

    def disconnect(self) -> None:
        with self._lock:
            self._token = None

    def request(self, method: str, path: str, body: dict | None = None) -> dict[str, Any]:
        _validate(method, path, body)
        with self._lock:
            token = self._token
        if token is None:
            raise StakeModeError("AUTH_REQUIRED")
        try:
            return self._send(method, path, body, token)
        except StakeModeError as error:
            if error.status != 401:
                raise
            with self._lock:
                if self._token == token:
                    self._token = None
                if method != "GET":
                    self._token = None
                    raise StakeModeError("AUTH_REQUIRED", 401) from None
                if self._token is None:
                    self.connect()
                token = self._token
            try:
                return self._send(method, path, token=token)
            except StakeModeError as retry_error:
                if retry_error.status == 401:
                    with self._lock:
                        self._token = None
                    raise StakeModeError("AUTH_REQUIRED", 401) from None
                raise

    def _send(self, method: str, path: str, body: dict | None = None, token: str | None = None) -> dict[str, Any]:
        try:
            data = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") if body is not None else None
        except (TypeError, ValueError, UnicodeError):
            raise StakeModeError("CONFIG") from None
        if data is not None and len(data) > _MAX_BYTES:
            raise StakeModeError("CONFIG")
        headers = {"X-StakeMode-Workspace": "1", "Accept": "application/json", "Cache-Control": "no-store"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"http://127.0.0.1:8080/workspace/api/{path}", data=data, headers=headers, method=method)
        if isinstance(self.timeout, bool) or not isinstance(self.timeout, (int, float)) or not 0.1 <= self.timeout <= 60:
            raise StakeModeError("CONFIG")
        deadline = time.monotonic() + self.timeout
        try:
            with self._opener.open(req, timeout=self.timeout) as response:
                status = response.getcode()
                if not 200 <= status < 300:
                    raise StakeModeError("AUTH_REQUIRED" if status == 401 else "HTTP", status)
                length = response.headers.get("Content-Length")
                if length is not None and (not re.fullmatch(r"[0-9]+", length) or int(length) > _MAX_BYTES):
                    raise StakeModeError("PROTOCOL")
                chunks, size = [], 0
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise StakeModeError("TIMEOUT")
                    # urllib's native HTTPResponse exposes read1 and its socket;
                    # update that socket's deadline to bound a trickling body too.
                    sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                    if sock is not None:
                        sock.settimeout(remaining)
                    read = getattr(response, "read1", response.read)
                    chunk = read(min(65536, _MAX_BYTES + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > _MAX_BYTES:
                        raise StakeModeError("PROTOCOL")
                    chunks.append(chunk)
                try:
                    result = json.loads(b"".join(chunks).decode("utf-8"))
                except (UnicodeError, ValueError):
                    raise StakeModeError("PROTOCOL") from None
                if not isinstance(result, dict):
                    raise StakeModeError("PROTOCOL")
                return result
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise StakeModeError("AUTH_REQUIRED" if status == 401 else "HTTP", status) from None
        except (TimeoutError, socket.timeout):
            raise StakeModeError("TIMEOUT") from None
        except urllib.error.URLError as error:
            raise StakeModeError("TIMEOUT" if isinstance(error.reason, (TimeoutError, socket.timeout)) else "TRANSPORT") from None
        except StakeModeError:
            raise
        except Exception:
            raise StakeModeError("TRANSPORT") from None

    def list_profiles(self):
        result = self.request("GET", "snapshot")
        profiles = result.get("snapshot", {}).get("profiles") if isinstance(result.get("snapshot"), dict) else None
        if not isinstance(profiles, list) or not all(isinstance(profile, dict) for profile in profiles):
            raise StakeModeError("PROTOCOL")
        return profiles
    def create_profiles(self, options: dict):
        return self.request("POST", "bulk", options)
    def start(self, profile_id: str):
        return self.request("POST", "start", {"profileId": _identifier(profile_id)})
    def stop(self, profile_id: str):
        return self.request("POST", "stop", {"profileId": _identifier(profile_id)})
    def manual(self, profile_id: str, enabled: bool = True):
        return self.request("POST", "manual", {"profileId": _identifier(profile_id), "enabled": enabled})
    def delete_profile(self, profile_id: str, confirmation: str):
        return self.request("DELETE", f"profiles/{_identifier(profile_id)}", {"confirmation": confirmation})
    def browser_state(self, profile_id: str):
        return self.request("GET", f"profiles/{_identifier(profile_id)}/browser")
    def browser_action(self, profile_id: str, command: dict):
        return self.request("POST", f"profiles/{_identifier(profile_id)}/browser", command)
    def groups(self):
        return self.request("GET", "library")
    def save_group(self, name: str, group_id: str | None = None):
        return self.request("POST", "library/groups", {"name": name, **({"id": _identifier(group_id)} if group_id else {})})
    def metadata(self, profile_id: str):
        return self.request("GET", f"library/profiles/{_identifier(profile_id)}")
    def set_metadata(self, profile_id: str, metadata: dict):
        return self.request("POST", f"library/profiles/{_identifier(profile_id)}", metadata)
    def import_profiles(self, document: dict):
        return self.request("POST", "library/import", {"document": document})
    def export_profiles(self, profile_ids: list[str] | None = None):
        query = "?ids=" + ",".join(map(_identifier, profile_ids)) if profile_ids is not None else ""
        return self.request("GET", f"library/export{query}")
    def extensions(self):
        return self.request("GET", "extensions")
    def import_extension(self, options: dict):
        return self.request("POST", "extensions/import", options)
    def profile_extensions(self, profile_id: str):
        return self.request("GET", f"profiles/{_identifier(profile_id)}/extensions")
    def assign_extension(self, profile_id: str, assignment: dict):
        return self.request("POST", f"profiles/{_identifier(profile_id)}/extensions", assignment)
    def assign_proxy(self, profile_id: str, options: dict):
        return self.request("POST", f"profiles/{_identifier(profile_id)}/network", options)
    def set_screen(self, profile_id: str, width: int, height: int):
        return self.request("POST", f"profiles/{_identifier(profile_id)}/screen", {"width": width, "height": height})
    def workflows(self):
        return self.request("GET", "workflows")
    def save_workflow(self, workflow: dict):
        return self.request("POST", "workflows", workflow)
    def run_workflow(self, workflow_id: str, profile_ids: list[str]):
        return self.request("POST", f"workflows/{_identifier(workflow_id)}/run", {"profileIds": list(map(_identifier, profile_ids))})
    def jobs(self):
        return self.request("GET", "jobs")
    def cancel_job(self, job_id: str):
        return self.request("POST", f"jobs/{_identifier(job_id)}/cancel", {})
    def job_output(self, job_id: str, format: str = "json"):
        return self.request("GET", f"jobs/{_identifier(job_id)}/output?format={format}")
    def sync_status(self):
        return self.request("GET", "sync")
    def follow(self, admin_id: str, follower_ids: list[str], save_session: bool = False):
        return self.request("POST", "sync", {"adminId": _identifier(admin_id), "followerIds": list(map(_identifier, follower_ids)), "saveSession": save_session})
    def stop_following(self):
        return self.request("DELETE", "sync")
    def resume_session(self):
        return self.request("POST", "sync", {"action": "resume"})
    def save_session(self, save_session: bool = True):
        return self.request("POST", "sync", {"action": "save", "saveSession": save_session})
    def proxies(self):
        return self.request("GET", "proxies")
    def import_proxies(self, options: dict):
        return self.request("POST", "proxies/import", options)
    def schedules(self):
        return self.request("GET", "schedules")
    def save_schedule(self, schedule: dict, schedule_id: str | None = None):
        return self.request("POST", f"schedules/{_identifier(schedule_id)}" if schedule_id else "schedules", schedule)


# Preferred branding; existing imports and exception handling remain compatible.
GameBrowserClient = StakeModeClient
GameBrowserError = StakeModeError
