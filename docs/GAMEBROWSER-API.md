# GameBrowser local API, SDKs and data compatibility

GameBrowser runs the upgraded StakeMode workspace directly in its own desktop application. It has its own product identity and data folder. Local profiles, browser controls, the live workspace, add-ons, proxies and automation work without a Cloud account. Cloud and Team settings remain optional.

## Local clients

Start GameBrowser before connecting. The default local service is `http://127.0.0.1:8080`; the SDK intentionally accepts that exact loopback origin. An explicitly changed development port is not accepted by these clients. Both the original StakeMode import names and the GameBrowser names point to the same implementation.

```ts
import { GameBrowserClient, GameBrowserError } from "./sdk/gamebrowser.ts";

const browser = new GameBrowserClient({ timeoutMs: 30_000 });
await browser.connect();
const profiles = await browser.listProfiles();
// Choose actual profile IDs from this local installation.
await browser.start(String(profiles[0]!.id));
browser.disconnect();
```

```python
from sdk.gamebrowser import GameBrowserClient, GameBrowserError

browser = GameBrowserClient(timeout=30)
browser.connect()
profiles = browser.list_profiles()
if profiles:
    browser.start(profiles[0]["id"])
browser.disconnect()
```

`sdk/stakemode.ts` and `sdk/stakemode.py` retain `StakeModeClient` and `StakeModeError` for existing scripts. Python uses only its standard library; TypeScript needs a runtime that supports TypeScript and `fetch`. To copy the Python client beside a script, include both `gamebrowser.py` and `stakemode.py`, or continue importing `stakemode.py` alone.

The [complete method and route reference](STAKE-MODE-API.md) covers profile lifecycle, manual browser controls, cookies, screen dimensions, groups, tags, notes, bookmarks, imported add-ons, proxy assignment, workflows, jobs and schedules. Profile IDs follow the same grammar as the application: 1–128 characters, starting with a letter or digit, containing letters, digits, `_` or `-`, excluding Windows device names such as `CON` and `COM1`.

## Admin, followers and saved sessions

Selecting a profile card does not change the current Admin or disconnect followers. Following assignments change through explicit following controls. The optional UI setting to follow a newly selected Admin is an intentional user preference.

```ts
await browser.follow("admin-profile-id", ["follower-profile-id"], true);
const session = await browser.syncStatus();
await browser.saveSession(true);
// After closing and reopening the application, resume deliberately:
await browser.resumeSession();
// Ends following while leaving the browser processes open:
await browser.stopFollowing();
```

Python provides `follow`, `sync_status`, `save_session`, `resume_session` and `stop_following`. A saved session stores the selected Admin and followers. Resume requires the appropriate local profiles and browser engines. A follower reconnects to future actions; missed clicks or typing are not replayed. Browser commands require Admin or explicit manual control, and do not silently remove a follower from its assignment. `stop(profileId)` stops that browser, while `stopFollowing()` ends the following session.

The SDK retains the original authenticated `/workspace/api` contract. `connect()` bootstraps an in-memory authorization token; requests never follow redirects or put tokens in URLs. A failed authenticated read may reconnect once. Mutations are never retried automatically. Request and response bodies are bounded at 1 MiB, and deadlines remain active while a request is in flight. Errors contain fixed diagnostic messages and HTTP status, without response bodies or secrets.

## Existing installations and offline state imports

A normal desktop update keeps the existing GameBrowser application identifier, `ng.solomon.gamebrowser`, and reuses its data in place. On Windows this is normally `%APPDATA%\ng.solomon.gamebrowser`. The standalone source runtime uses an explicitly supplied `--state-root`, `GAMEBROWSER_STATE_ROOT`, the native `--desktop-root`, `STAKEMODE_STATE_ROOT` for compatibility, or its own GameBrowser directory. It does not merge data into an AliasMode installation.

The original StakeMode preview used `%LOCALAPPDATA%\StakeMode` for its source CLI, and normally `%APPDATA%\com.solomongs.stakemode` for its Windows desktop application. **Settings → Data** detects those known locations without changing them. A custom original folder can be supplied explicitly to the import command.

Close both applications and every browser using their profiles. Preview a full-root copy into a **new, empty** destination:

```sh
bun GameBrowser-cli.ts import-state --source "/path/to/StakeMode" --state-root "/path/to/GameBrowser-import"
```

Review the source, destination, profile count, file count, total bytes and content fingerprint in the printed plan. Then run the explicit copy:

```sh
bun GameBrowser-cli.ts import-state --source "/path/to/StakeMode" --state-root "/path/to/GameBrowser-import" --confirm-copy
bun GameBrowser-cli.ts start --state-root "/path/to/GameBrowser-import"
```

The importer copies the complete compatible state root, including `profiles.sqlite`, browser profile folders, fingerprints, cookies and storage files, browser bookmarks, imported add-ons, proxy libraries, group metadata, workflows and schedules. It preserves both the original `workspace/` layout and beta 82's `live-workspace/local/workspace/` layout. The runtime reuses the applicable layout. If both contain workspace data, startup requires an explicit `--workspace-state-root` choice; neither is overwritten.

Only the transient native `agent-runtime.json` descriptor is excluded. The old installation is never moved or edited. The destination is built in a private staging folder and committed only after the source, staged files and stopped-process proof pass again. Existing destination data is refused. If an empty destination directory already existed, its empty backup is retained beside the new directory. A receipt is written in the copied root. A failed commit attempts to restore that empty destination.

An incomplete process scan, unknown browser ownership, saved launch records, unsafe profile IDs, missing initialized browser folders, symbolic links, Windows junctions, hard links or special files stop the import. Open and close the old application cleanly if stale launch records remain. The importer does not kill another application's processes or clear ownership records to force a copy.

Windows Chromium secrets may require the original machine and Windows account. The importer verifies supported DPAPI keys with that account and refuses a copy when it cannot verify them. Other OS keychains and browser-specific encryption still depend on their original environment. A full state copy preserves the browser files; it does not make encrypted sessions portable to another machine or promise that websites will keep a login valid.

SDK `importProfiles()` / `exportProfiles()` retain the original **configuration template** API. The UI also offers richer profile file import/export. These are distinct from the offline full-root import: templates do not contain browser storage directories, encrypted secrets or a complete native session backup.

## Cloud queue recovery

The encrypted pending session queue is bound to its Cloud service in `pending-sync-service.json`. Changing to another service is refused while any account has queued browser opens or captured closes. Reconnect the original service and finish synchronization first. An empty queue can be rebound. A legacy queue without a binding is only adopted when the original `config.json` identifies the same service; otherwise its provenance must be recovered before use. Keep the queue database, its sidecars, its encryption key and its service record together. Deleting a binding does not safely move browser sessions to another service.

Cloud workspace identity is verified against fresh service payloads and current edit permissions. Reusing a profile ID in another account or service does not expose the prior account's cached identity. A failed final capture cancels sign-out while retaining browser ownership, credentials and the device binding for recovery.

## Checks

```sh
bun test sdk/stakemode.test.ts standalone/migration.test.ts standalone/cloud-lifecycle.test.ts standalone/queue-service-binding.test.ts
python3 -m unittest discover -s sdk -p 'test_*.py'
```

SDK checks cover authentication, strict loopback routing, redirect refusal, request bounds, deadlines, explicit mutation retry policy, following helpers and compatible profile IDs. Import fixtures verify byte-preserving copies, both workspace layouts, process ownership refusal, changed-source rejection, destination protection, link rejection and commit rollback. They do not copy an actual user's installation.
