# GameBrowser

Windows browser profile workspace developed by **Solomon Gbeta — [solomon.ng](https://solomon.ng)**.

GameBrowser adapts the complete Apache-2.0 [AliasMode desktop application](https://github.com/aliasmode/aliasmode), pinned to commit `0361bf4d4c53c993e5df80f1e7a2b6e9eb8a3538`. Upstream copyright notices, engine identities and licenses are preserved in LICENSE and NOTICE. This repository focuses on Windows x64 distribution.

## Download

[Windows releases](https://github.com/MultilancerNG/GameBrowser/releases) · [Source](https://github.com/MultilancerNG/GameBrowser)

The cyber download page lives in `site/`. Its GitHub Pages workflow publishes to `https://multilancerng.github.io/GameBrowser/` after Pages is enabled with **GitHub Actions** as its source. Windows beta 78 has full and slim installers plus SHA-256 checksums in Releases, and has passed a fresh installed-app smoke check including Local MCP initialization, tool listing and agent discovery. It includes the latest following, import/export, and device-local browser resource controls. Newer source changes are released only after their Windows workflow passes. Installed-app validation is tracked separately from compilation.

## Features

- **Local mode:** no account and no AliasMode Cloud connection. Profile data stays on this computer. Browser engine downloads and websites still use the network.
- **Cloud sync:** retained AliasMode Cloud client, verified-account sign-in, shared workspaces, folder permissions, portable encrypted profile sync and device access controls. This requires an accessible compatible Cloud service. The hosted backend is separate from the public desktop source; this fork does not include or claim to operate it.
- **Bulk delete:** select profiles across pages and choose Delete. Local and current Cloud mode move profiles to recoverable Trash; locked or failed profiles remain selected. Permanent purge is a separate action with workspace permission checks.
- **Admin profile controls:** in Cloud mode, owners and admins can open a profile’s access menu to grant or revoke view/edit access. Folder grants apply to descendants; direct profile grants follow a profile when moved. Ordinary members cannot change profile or folder grants through the local API. The compatible Cloud service remains responsible for authoritative workspace authorization.
- **Separate profile identities:** each newly created profile has its own ID, browser data directory and saved fingerprint seed. Creation checks stored seeds, including Trash, before deriving an identity. Imports and explicit fingerprint edits preserve the operator’s chosen identity. Cloud-wide uniqueness across other devices depends on the service.
- **Per-profile fingerprints:** persistent identity seed, screen, platform, timezone, locale and supported engine hardware settings. Engine-specific fingerprint attestation is retained. CloakBrowser identities can be linked on one computer; prefer the upstream AliasMode engines for separate identities. These settings do not guarantee anonymity or an undetectable browser.
- **Viewport presets:** desktop, iPhone-sized, Pixel-sized and tablet-sized screens, available in **Fingerprint settings** when creating or editing an existing profile. Custom dimensions remain editable. Save and relaunch a stopped profile to apply changes. Mobile sizes change screen dimensions; they do not change the operating system, user agent or touch capabilities to a mobile device.
- **MCP and agent clients:** retained local MCP tools, agent integration, authenticated remote MCP connectors and Cloud tunnel lifecycle. Remote capabilities require the compatible Cloud service.

Engine names, internal executable names (`aliasmode-sidecar`, `aliasmode-mcp`), protocol names and environment variables are retained for runtime compatibility. The desktop executable is `gamebrowser.exe`; the application, installer product and landing page are branded GameBrowser. Windows agent discovery uses the separate `ng.solomon.gamebrowser` data directory.

## Profile workspace

Drag a profile’s handle to arrange profiles, or focus the handle and use Arrow Up / Arrow Down. Manual order is saved in the local database across application restarts, separately for Local mode and each signed-in Cloud account. It is a device preference, not a Cloud-synchronized workspace setting. Column sorting is still available; **Saved order** restores the manual layout.

Selecting a profile moves it to the top of the view. Before starting a sync group, the most recently selected profile is the candidate **Admin** (violet), with other selected profiles as **Followers** (teal). By default, those assignments and colors stay fixed once following starts. Clicking or deselecting a follower changes only the view selection. Use **Apply selection** to change the group, or **Stop following** to end it. Use the **Admin profile** selector to choose among selected Chromium profiles. The optional **Auto-follow Admin selection** setting makes the latest selected Chromium profile Admin and applies the other selected profiles as followers automatically. It starts off, resets when the app or account/workspace changes, and turns off when you choose Stop. Invalid or incomplete selections leave the current group intact. Cloud authorization still uses separate owner/admin/member account permissions.

Open the profiles, choose a Chromium Admin and up to 20 Chromium or Firefox followers, then select **Start following**. Trusted clicks, text input, checkbox/select changes, standard keys, scrolling, and website navigation are replayed independently. Each browser retains its own cookies, login/session storage, and fingerprint. File uploads and operating-system dialogs are not replayed. Firefox can follow; trusted Admin capture currently requires Chromium.

Use **Save session** (or the save-on-start option) to retain the Admin/follower choices in the local database. **Resume saved session** restores that group after an app restart; it does not launch browsers automatically. If a browser closes while a group is enabled, the group waits with its assignments intact and reconnects after the same profiles reopen. Reconnection sends future actions only, never replays old clicks or submissions. Pages that no longer match pause replay for attention. Stop ends the current group while retaining a saved plan; **Forget saved session** removes the plan without restarting an active group. Account changes or revoked access require fresh authorization.

Saved sync groups contain only profile IDs and are isolated between Local mode and authorized Cloud accounts. Browser login/tab restoration continues to use each profile’s existing storage and close/open lifecycle.

## Import and export

Use **Import profiles** in the sidebar to upload supported TXT, CSV, JSON or XLSX exports, or paste a supported account export. Choose the destination group before importing. Imports preserve the supplied identity and session data; unsupported encrypted provider archives need a readable export first.

Use **Export profiles** in the sidebar for selected profiles or the current filtered view. A profile’s edit dialog also offers **Export saved profile**. TXT and XLSX carry the supported saved identity/cookie fields; CSV exports account credentials. These readable exports are not full browser-directory backups. Exporting does not change the selection or following assignments. Cloud exports require edit access to every profile. Device-only resource preferences and saved following groups are not part of portable exports.

## Browser resource settings

Open an existing profile’s edit dialog to set **RAM budget, MB**, **Auto optimize**, and **Always show bookmarks bar**. Auto calculates a target from this device’s memory and the number of running profiles; manual targets accept 128–32768 MB. Optimization is opt-in and adjusts Chromium renderer heaps and caches, or Firefox’s memory cache. It is a soft target, not a total browser-process RAM limit or a reservation of physical memory. A renderer heap limit can be visible to websites.

Settings are stored on this device and apply on the next fresh browser launch. Saving them leaves running browsers and following groups intact. The bookmarks option can retain the current behavior or explicitly choose an always-visible bar; existing bookmarks are preserved.

## Windows development

Install Bun **1.2.21**, Rust **1.89**, Visual Studio C++ Build Tools and the Windows SDK. Then:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test
bun cli.ts start
```

The dashboard and Local API bind to loopback. Choose Local on first use to run without an account. Profiles use persistent SQLite and per-profile browser directories. Set `ALIASMODE_STATE_ROOT` to choose a separate state directory for source development.

## Build Windows installers

Run **Actions → GameBrowser Windows → Run workflow**. It downloads the pinned upstream Firefox archive, verifies its published SHA-256, prepares the sidecar with verified baseline Bun, and builds full and slim NSIS installers with a checksum file. The release workflow gates publication on a fresh Windows install/start/Local-mode/MCP/shutdown/uninstall smoke check. The full installer bundles WebView2; the slim installer downloads it when required. The upstream engine archive must remain publicly available.

The artifact is `gamebrowser-windows-x64`. For a prerelease, push a `v` tag matching the version in `src-tauri/tauri.conf.json` after checking the build. Tag builds publish installers and `SHA256SUMS.txt` to this repository's Releases. Installers are currently unsigned; Windows may show an unknown publisher prompt. Test installation, profile launch, update and uninstall on Windows before a public stable release.

The retained signed updater points only to this repository's releases. Before enabling signed in-app update publication, replace the upstream updater public key in `src-tauri/tauri.conf.json` with a GameBrowser key and securely configure the corresponding signing key. Unsigned installers cannot be installed by the signed updater. Do not publish an upstream update manifest as a GameBrowser update.

## MCP setup

Use the installed `aliasmode-mcp.exe` helper for local agent clients; its name remains compatible with upstream tooling. The dashboard's MCP settings provide the supported agent configuration and Cloud connector setup. See the bundled `docs/` for API and MCP contracts. No Cloud credential is required in Local mode.

## Attribution

GameBrowser modifications © 2026 Solomon Gbeta. AliasMode upstream © 2026 Xreacher. See [NOTICE](NOTICE), [LICENSE](LICENSE), and engine-specific licenses. GameBrowser is an independent adaptation and does not claim ownership of AliasMode's engines or hosted service.
