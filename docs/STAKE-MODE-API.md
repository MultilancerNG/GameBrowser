# StakeMode-compatible local REST API and SDKs

GameBrowser is the independent upgrade of StakeMode. Existing `StakeModeClient` / `StakeModeError` imports continue to work; new integrations can use `GameBrowserClient` / `GameBrowserError` from `sdk/gamebrowser.ts` or `sdk/gamebrowser.py`. See [the GameBrowser guide](GAMEBROWSER-API.md) for following sessions and safe offline imports.

GameBrowser exposes an authenticated local REST API while the application is open. The clients in `sdk/stakemode.ts` and `sdk/stakemode.py` require no additional libraries. They retain StakeMode's `/workspace/api` routes. They are **not drop-in NSTbrowser SDKs**, CDP clients, or remote browser services.

The application must already be running on `http://127.0.0.1:8080`. Profile start uses the installed, pinned browser engines. These SDKs do not install browsers or start the desktop application.

## TypeScript (Bun or a TypeScript-capable Node runtime)

```ts
import { StakeModeClient } from "./sdk/stakemode.ts";

const stake = new StakeModeClient({ timeoutMs: 30000 });
await stake.connect();
const profiles = await stake.listProfiles();
const id = String(profiles[0]?.id ?? "");

if (id) {
  await stake.start(id);
  await stake.manual(id, true);
  const { browser } = await stake.browserState(id);
  await stake.browserAction(id, {
    action: "navigate",
    url: "https://example.com/",
  });
  await stake.stop(id);
}
stake.disconnect();
```

## Python 3.10 or newer

Run from the repository root with `PYTHONPATH=sdk`, or place `stakemode.py` next to your script.

```python
from stakemode import StakeModeClient

stake = StakeModeClient(timeout=30)
stake.connect()
profiles = stake.list_profiles()

if profiles:
    profile_id = profiles[0]["id"]
    stake.start(profile_id)
    stake.manual(profile_id, True)
    stake.browser_action(profile_id, {
        "action": "navigate",
        "url": "https://example.com/",
    })
    stake.stop(profile_id)
stake.disconnect()
```

`connect()` returns the initial snapshot, without the authorization token. Each other method returns the API's JSON wrapper, except `listProfiles()` / `list_profiles()`, which return the profile array. No SDK method writes files or logs request bodies, responses, browser addresses, cookies, proxy passwords or tokens. If you choose to handle a private browser/cookie response in your own script, keep that response private.

## Available methods and routes

Python uses the corresponding `snake_case` method names.

| Task | TypeScript method | REST route |
| --- | --- | --- |
| Profiles | `listProfiles()`, `createProfiles(input)` | `GET snapshot`, `POST bulk` |
| Lifecycle | `start(id)`, `stop(id)`, `manual(id, enabled)` | `POST start`, `stop`, `manual` |
| Delete local profile | `deleteProfile(id, confirmation)` | `DELETE profiles/:id` |
| Browser | `browserState(id)`, `browserAction(id, command)` | `GET/POST profiles/:id/browser` |
| Desktop screen | `setScreen(id, width, height)` | `POST profiles/:id/screen` |
| Groups | `groups()`, `saveGroup(name, id?)` | `GET library`, `POST library/groups` |
| Metadata | `metadata(id)`, `setMetadata(id, metadata)` | `GET/POST library/profiles/:id` |
| Templates | `importProfiles(document)`, `exportProfiles(ids?)` | `POST library/import`, `GET library/export` |
| Add-ons | `extensions()`, `importExtension(options)` | `GET extensions`, `POST extensions/import` |
| Add-on assignment | `profileExtensions(id)`, `assignExtension(id, assignment)` | `GET/POST profiles/:id/extensions` |
| Network/proxy | `assignProxy(id, options)`, `proxies()`, `importProxies(options)` | `POST profiles/:id/network`, `GET proxies`, `POST proxies/import` |
| Following session | `syncStatus()`, `follow(adminId, followerIds, saveSession?)`, `stopFollowing()` | `GET/POST/DELETE sync` |
| Saved following session | `saveSession(enabled?)`, `resumeSession()` | `POST sync` |
| Workflows | `workflows()`, `saveWorkflow(workflow)`, `runWorkflow(id, profileIds)` | `GET/POST workflows`, `POST workflows/:id/run` |
| Jobs | `jobs()`, `cancelJob(id)`, `jobOutput(id, format)` | `GET jobs`, `POST jobs/:id/cancel`, `GET jobs/:id/output` |
| Schedules | `schedules()`, `saveSchedule(schedule, id?)` | `GET/POST schedules`, `POST schedules/:id` |

`request(method, relativePath, body?)` supports the remaining documented local management operations. It accepts `GET`, `POST` and `DELETE` only, validates management route names and IDs (1–128 letters/digits/underscores/hyphens, starting with a letter or digit, excluding Windows device names), and rejects arbitrary URLs, driver endpoints, traversal and unknown query parameters.

Examples:

```ts
await stake.request("POST", "pause", { profileId: id, enabled: true });
await stake.request("DELETE", "schedules/schedule_0123456789abcdef0123456789abcdef");
await stake.assignProxy(id, { networkMode: "system" });
await stake.setScreen(id, 1473, 913); // Profile must be stopped.
```

Network changes and add-on changes require a stopped profile. `networkMode` is `direct`, `system` or `proxy`; proxy mode also accepts the server's proxy endpoint string or structured proxy object. System mode uses the existing OS network route; it does not create a VPN.

Desktop screen changes also require a stopped profile with no lifecycle operation in progress. `POST profiles/:id/screen` accepts only `{width, height}` and returns `{profile, snapshot}`. Width must be an integer from 320 to 4,096 pixels; height must be an integer from 200 to 4,096, and the total must not exceed 8,847,360 pixels. Invalid values return 400 and active-profile edits return 409. Python uses `stake.set_screen(profile_id, 1473, 913)`. The next launch and new tabs retain the saved desktop viewport; changing the dashboard’s viewer size does not change it or enable mobile emulation. Bulk creation accepts these dimensions through `resolutions: [{width: 1473, height: 913}]`.

Browser commands support `navigate`, `back`, `forward`, `reload`, `stop`, `new-tab`, `select-tab` and `close-tab`. Browser state provides opaque tab IDs; pass those IDs back for tab selection/closure. Manual browsing accepts HTTPS and loopback HTTP URLs. Direct browser HTTP responses can contain full address-bar URLs; public snapshots and streams redact queries and fragments. Browser commands require an Admin or a profile explicitly switched to manual control first. They do not silently change a follower’s role or its saved following assignment.

Profile deletion requires the exact profile ID in `confirmation`, a stopped profile and verified process ownership. This deletes local profile data, never an account at a website.

Workflows are limited to read-only navigation, waits, scrolling and public text/title/URL extraction. They do not enter credentials, click financial controls or execute arbitrary JavaScript. Schedules require the application to remain open and eligible profiles to already be running in manual control.

## Authentication, retries and bounds

The SDKs bootstrap with `X-StakeMode-Workspace: 1` and hold the returned token only in memory. Subsequent calls send `Authorization: Bearer …`. The fixed service address is `http://127.0.0.1:8080`; other hosts, ports, schemes, credentials, paths and base URL query strings are rejected. Requests never follow redirects. Python also disables environment proxies for these control requests.

A failed `GET` with status 401 may reconnect and retry once. A mutation receiving 401 is never repeated automatically: the cached token is cleared and `StakeModeError` instructs the caller to call `connect()` before another write. Connection failures and timeouts also do not retry mutations. Check the resulting profile/job state before deliberately repeating an operation whose response was lost.

Each request and response is limited to 1 MiB in the SDK. Server route limits can be smaller; ordinary JSON writes are limited to 64 KiB. Timeouts default to 30 seconds, with a configurable maximum of 60 seconds. Errors contain fixed messages, a diagnostic code and an optional HTTP status; they do not echo server bodies, URLs or credentials.

## Validation

```sh
bun test sdk/stakemode.test.ts
python -m unittest discover -s sdk -p 'test_*.py'
```

TypeScript tests use mock HTTP responses. Python tests run real local HTTP fixtures, on ephemeral ports through a test-only transport, including a redirect capture endpoint that must never receive a request, and a delayed response proving the socket body timeout.
