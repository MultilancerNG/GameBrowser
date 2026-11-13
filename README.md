# GameBrowser

Windows browser profile workspace developed by **Solomon Gbeta — [solomon.ng](https://solomon.ng)**.

GameBrowser adapts the complete Apache-2.0 [AliasMode desktop application](https://github.com/aliasmode/aliasmode), pinned to commit `0361bf4d4c53c993e5df80f1e7a2b6e9eb8a3538`. Upstream copyright notices, engine identities and licenses are preserved in LICENSE and NOTICE. This repository focuses on Windows x64 distribution.

## Download

[Windows releases](https://github.com/MultilancerNG/GameBrowser/releases) · [Source](https://github.com/MultilancerNG/GameBrowser)

The cyber download page lives in `site/`. Its GitHub Pages workflow publishes to `https://multilancerng.github.io/GameBrowser/` after Pages is enabled with **GitHub Actions** as its source. Until a Windows workflow finishes and publishes a tagged release, no GameBrowser installer is available. Build artifacts are not evidence of a tested installation.

## Features

- **Local mode:** no account and no AliasMode Cloud connection. Profile data stays on this computer. Browser engine downloads and websites still use the network.
- **Cloud sync:** retained AliasMode Cloud client, verified-account sign-in, shared workspaces, folder permissions, portable encrypted profile sync and device access controls. This requires an accessible compatible Cloud service. The hosted backend is separate from the public desktop source; this fork does not include or claim to operate it.
- **Bulk delete:** select profiles across pages and choose Delete. Local and current Cloud mode move profiles to recoverable Trash; locked or failed profiles remain selected. Permanent purge is a separate action with workspace permission checks.
- **Per-profile fingerprints:** persistent identity seed, screen, platform, timezone, locale and supported engine hardware settings. Engine-specific fingerprint attestation is retained. CloakBrowser identities can be linked on one computer; prefer the upstream AliasMode engines for separate identities. These settings do not guarantee anonymity or an undetectable browser.
- **Viewport presets:** desktop, iPhone-sized, Pixel-sized and tablet-sized screens, available in **Fingerprint settings** when creating or editing an existing profile. Custom dimensions remain editable. Save and relaunch a stopped profile to apply changes. Mobile sizes change screen dimensions; they do not change the operating system, user agent or touch capabilities to a mobile device.
- **MCP and agent clients:** retained local MCP tools, agent integration, authenticated remote MCP connectors and Cloud tunnel lifecycle. Remote capabilities require the compatible Cloud service.

Engine names, internal executable names (`aliasmode`, `aliasmode-sidecar`, `aliasmode-mcp`), protocol names and environment variables are retained for runtime compatibility. The application, installer product and landing page are branded GameBrowser.

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

Run **Actions → GameBrowser Windows → Run workflow**. It downloads the pinned upstream Firefox archive, verifies its published SHA-256, prepares the Bun sidecar, and builds full and slim NSIS installers with a checksum file. The full installer bundles WebView2; the slim installer downloads it when required. The upstream engine archive must remain publicly available.

The artifact is `gamebrowser-windows-x64`. For a prerelease, push a `v` tag matching the version in `src-tauri/tauri.conf.json` after checking the build. Tag builds publish installers and `SHA256SUMS.txt` to this repository's Releases. Installers are currently unsigned; Windows may show an unknown publisher prompt. Test installation, profile launch, update and uninstall on Windows before a public stable release.

The retained signed updater points only to this repository's releases. Before enabling signed in-app update publication, replace the upstream updater public key in `src-tauri/tauri.conf.json` with a GameBrowser key and securely configure the corresponding signing key. Unsigned installers cannot be installed by the signed updater. Do not publish an upstream update manifest as a GameBrowser update.

## MCP setup

Use the installed `aliasmode-mcp.exe` helper for local agent clients; its name remains compatible with upstream tooling. The dashboard's MCP settings provide the supported agent configuration and Cloud connector setup. See the bundled `docs/` for API and MCP contracts. No Cloud credential is required in Local mode.

## Attribution

GameBrowser modifications © 2026 Solomon Gbeta. AliasMode upstream © 2026 Xreacher. See [NOTICE](NOTICE), [LICENSE](LICENSE), and engine-specific licenses. GameBrowser is an independent adaptation and does not claim ownership of AliasMode's engines or hosted service.
