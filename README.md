# GameBrowser

An independent Windows browser workspace developed by **Solomon Gbeta — [solomon.ng](https://solomon.ng)**. GameBrowser upgrades the standalone StakeMode project, preserving its Live workspace, browser controls and local data model.

The independent upgrade is being validated on this branch. **Beta 82 remains the published installer until the new installed Windows gate passes.** [Downloads](https://github.com/MultilancerNG/GameBrowser/releases) · [Feature checklist](FEATURE_CHECKLIST.md)

## Independent application

`GameBrowser-cli.ts` starts the application's own loopback server, profile store, browser launcher, Live workspace and settings. Its normal runtime does not import the AliasMode host CLI, host web server, React dashboard or integration wrapper. Shared browser and service libraries retain their original licenses and engine identities.

The baseline is the supplied `AliasMode-Game-stakemode-v0.1.0-preview.2.zip`, with certified browser/runtime fixes from GameBrowser beta 82. See [architecture and provenance](docs/INDEPENDENT-STAKEMODE-UPGRADE.md). The native application retains `ng.solomon.gamebrowser` as its identity so updates continue using existing GameBrowser data.

## Live workspace

The approved dark Live workspace opens directly. Local profiles work without an account. Configure approved websites, create or import profiles, and start the browser tiles. Tiles display actual browser pixels, with independent tabs, navigation, bookmarks, Full view and Full Admin View.

Either Chromium or Firefox can be Admin. Choose Admin and followers explicitly, or enable **Auto-follow Admin selection**. Violet identifies Admin; teal identifies followers. Selecting a tile changes its position without changing an active following group. Drag handles and keyboard controls retain manual order.

Following uses one controller. Supported clicks, text changes and scrolling replay independently; approved navigation and tab actions use the owned browser connections. Profiles retain separate cookies, storage and fingerprints. Sensitive interactions, uploads and operating-system dialogs require manual action. Page mismatches or unavailable browsers pause replay while retaining assigned roles. Reconnection sends future actions without replaying a backlog.

**Save session** retains the following plan. After reopening, choose **Resume saved session** explicitly; it does not launch browsers automatically. **Stop following** keeps browsers open. The original limit remains 256 profiles, with one Admin and up to 255 followers; practical capacity depends on the computer.

## Profiles and tools

- Create profiles and edit stopped identities, screen dimensions, locale, timezone and user agent.
- Import/export supported TXT, CSV, JSON and XLSX data directly in the workspace. These preserve supported identities and saved sessions; they are not complete browser-folder backups.
- Use recoverable Trash, restoration and separately confirmed permanent deletion.
- Organize groups, tags, notes and bookmarks; copy configuration into fresh identities.
- Inspect verified CPU/RAM measurements and use ownership-checked browser stop controls.
- Choose Direct/System/Proxy routes; manage Chromium extensions and Firefox XPI add-ons.
- Run bounded local workflows and schedules while the app stays open.

Per-profile **RAM budget, MB**, automatic allocation, optional **Auto optimize**, and **Always show bookmarks bar** apply at the next fresh launch. Saving preferences retains running sessions and following assignments. RAM budgets are soft targets, not physical reservations or total-process limits. Mobile-sized screens change dimensions without emulating a mobile operating system or touch hardware.

## Optional Cloud and Team

Settings provides compatible Cloud configuration, sign-in and explicit restoration of saved native sign-in. Local and Cloud have separate authenticated routes, stores and browser owners. Cloud access uses current service permissions. **Settings → Team** provides member invitations and profile/group view or edit grants.

Cloud sessions retain the coordinator, encrypted pending-save queue and capture-before-close lifecycle. The compatible hosted backend is supplied separately. Simulated-service tests are identified in the checklist; live Cloud verification, remote MCP verification and the requested Sites/Cloudflare domain remain external setup.

## SDK and existing data

Original TypeScript/Python StakeMode SDK imports remain compatible, with additive GameBrowser names. The default is `http://127.0.0.1:8080`; a busy port is reported instead of adopting another service. See [GameBrowser API](docs/GAMEBROWSER-API.md) and [StakeMode API](docs/STAKE-MODE-API.md).

Existing beta 82 profiles and nested workspace metadata are reused in place. Settings → Data lists original StakeMode sources. Close both apps and review a full-state copy into a new empty destination:

```powershell
bun GameBrowser-cli.ts import-state --source "PATH_TO_STAKEMODE" --state-root "NEW_EMPTY_FOLDER"
# Review the plan, then repeat with --confirm-copy.
```

The installed `aliasmode-sidecar.exe` accepts the same import arguments. The source stays unchanged, including identities, browser data, bookmarks, add-ons, proxies, workflows and schedules. Existing databases are never merged or overwritten.

## Development and Windows builds

Install Bun **1.2.21**, Rust **1.89**, Visual Studio C++ Build Tools and the Windows SDK.

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test
bun start
```

Use `GAMEBROWSER_STATE_ROOT` or `--state-root` for a separate source data folder; `STAKEMODE_STATE_ROOT` remains compatible. Native updates keep the established application data folder.

The **GameBrowser Windows** workflow builds full/offline and slim installers with SHA-256 checksums. Publication requires Windows source checks and fresh installed-app tests of actual Chromium/Firefox controls, following, add-ons, saved-session reopening, MCP discovery, shutdown and uninstall. Tagged builds require reviewed notes in `release-notes/`. Downloads are promoted after the gate passes.

## MCP

The installed `aliasmode-mcp.exe` helper discovers the native runtime securely and supports local agent setup without Cloud. For example, `aliasmode-mcp.exe setup --client codex --yes` configures the selected supported client. Settings identifies the bridge; its private credential is not a dashboard token and is never stored in browser persistence. Remote capabilities require a compatible service and separate verification.

## Attribution

GameBrowser modifications © 2026 Solomon Gbeta. AliasMode upstream © 2026 Xreacher; the desktop baseline was pinned to `0361bf4d4c53c993e5df80f1e7a2b6e9eb8a3538`. See [NOTICE](NOTICE), [LICENSE](LICENSE) and engine-specific licenses. GameBrowser is independent of AliasMode's hosted service. Internal engine, executable and protocol names remain where required for compatibility.
