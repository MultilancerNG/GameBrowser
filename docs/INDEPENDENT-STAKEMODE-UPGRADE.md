# Independent GameBrowser upgrade of StakeMode

This document describes the independent upgrade under development. **The published Windows installer remains beta 82 until a new installer passes the release gates.** Beta 82's mounted workspace does not establish that this standalone upgrade has shipped.

The product keeps the **GameBrowser** name and the approved dark Live workspace interface. Its application entry is now `GameBrowser-cli.ts`, which directly starts the standalone runtime, profile store, browser launcher and workspace. Desktop startup no longer invokes the AliasMode application entry, React dashboard or `workspace-integration.ts`. Shared browser engine, profile storage, Cloud protocol and MCP libraries retain their upstream licenses.

## Source provenance

The baseline is the user-supplied `AliasMode-Game-stakemode-v0.1.0-preview.2.zip`, SHA-256 `0cfee5999afba003ca10a731ee8ae9e1d6ef26f3b40d4258c33aeab1a9094776`. Its standalone `StakeMode-cli.ts`, workspace, sync relay, local extensions, workflows, resource monitoring and SDK contracts are the compatibility reference. The supplied source is reference material; its embedded instruction files do not override the user's requirements.

The Windows package retains the newer verified Firefox 156 runtime and official Node 22 runtime. Firefox add-on UI compatibility sources and MPL notices remain included. The native executable checksum is checked again after that compatibility patch. The restored TypeScript/Python SDKs, branded aliases and both API guides ship beside the workspace assets.

## Functions retained or upgraded in source

“In source” means implemented in this upgrade branch. It does not mean the new installer has passed native acceptance or been published.

| Function | Independent upgrade behavior |
| --- | --- |
| Local application | Own loopback workspace and Settings; no account required for local profiles. |
| Live browser workspace | Real Chromium/Firefox frames, independent tabs and address controls, Full Admin View, grid return and manual browser input. |
| Admin and followers | Restore Firefox as an Admin, alongside Chromium Admin and mixed-engine followers. Original authenticated capture/relay path provides one replay controller; approved explicit navigation and tab controls follow in either direction. |
| Explicit role changes | Draft selection does not disconnect followers; Apply, Manual, Pause, Reconnect and Stop are deliberate controls. Admin and follower borders keep distinct violet/teal colors. |
| Following limits | Preserve the original 256-profile workspace, with one Admin and up to 255 distinct followers; visible live streams and launch concurrency remain bounded. |
| Following sessions | Save, forget and explicitly resume assignments; retain roles across transport loss and profile reopen; reconnect sends future actions only. Stop following keeps the browser processes open. |
| Ordering | Drag/drop and keyboard rearrangement, saved order, selected profile first, and optional automatic following after choosing Admin. |
| Profile management | Own identity editor, full TXT/CSV/JSON/XLSX import/export, configuration-only templates, recoverable Trash, groups, tags, notes, bookmarks and fresh-identity copies. |
| Browser preferences | Auto/manual RAM budget, optional optimization on the next launch, and per-profile bookmarks-bar preference. RAM budgets remain monitored targets rather than hard process-memory caps. |
| Viewports | Preserve the saved launch-generation viewport, including the verified Firefox content-size adjustment; scaling a tile does not resize its browser. |
| Network routes | Direct, System and per-profile HTTP/SOCKS proxy configuration; saved proxy library and credential-redacted listings. |
| Extensions and add-ons | Local Chromium MV3 folders and Firefox XPI packages, immutable import digest, reviewed assignment/site scope, real popup/options pages, and disable-on-restart behavior. |
| Local automation | Bounded read-only workflows, cancellation, JSON/CSV outputs and one-off/recurring schedules while the application stays open. |
| Resource controls | Verified native CPU/RAM/process readings and ownership-checked graceful Stop/Force close. |
| Optional Cloud | Own account and Team settings, group/profile sharing, verified current grants and Cloud lifecycle integration. Live service acceptance is separate from mocked protocol checks. |
| MCP and agents | Preserve installed local MCP/agent discovery and private authenticated runtime transport. Remote service acceptance remains pending. |
| Existing data | Keep the GameBrowser application directory; detect original StakeMode and beta 82 metadata. Offline copy/import is explicit, validated and leaves the source unchanged. Conflicting roots require a deliberate choice. |

Following retains the original manual boundary for sensitive authentication and financial controls. Extension host selection follows browser host-pattern rules, including their lack of exact TCP-port isolation. These are existing functional limits, not claims of complete page automation or an extension sandbox.

## Required release evidence

The Windows workflow must install and run the built application from its installed directory. The gate now requires:

- Standalone product health, direct workspace entry, an empty fresh Local workspace and no unexpected engine downloads.
- Installed MCP helper version, local profile discovery, MCP initialization/tools and clean helper shutdown.
- Actual bundled Firefox frames, trusted manual click/typing, browser tabs and address navigation.
- Actual Chromium Admin → Firefox follower and Firefox Admin → Chromium follower click/typing, with the distinct role palette.
- Explicit Admin address navigation, reload, new tab, tab selection and tab close in both native engine directions.
- A financial-labelled local fixture remains independent manual input while Admin/follower roles stay assigned; it has no real financial operation.
- Follower selection retaining the connection, saved roles surviving workspace reload, Stop retaining exact browser processes and following after a fresh Firefox generation.
- Private cookies reaching the selected native jar and clearing there without appearing in another profile.
- Read-only workflows on both native engines, exact JSON/CSV outputs, a consumed one-off Firefox schedule and verified native resource metrics.
- Harmless local packages in both engines, actual popup/options input, reviewed host scope and disabled package state after restart.
- Saved assignments surviving complete native desktop close/reopen, followed by explicit Resume without silently starting stopped browsers.
- Graceful shutdown of the owned sidecar, descriptor cleanup and uninstall preserving profile data.

Packaging unit tests, source bundling, JavaScript syntax validation and PowerShell parsing have passed during development. **The new installed Windows gate has not yet passed.** Full source checks and native results must be recorded against the final immutable release commit before publishing.

## Pending delivery and external checks

- Complete the independent runtime/UI/Cloud integration and review all source regression results.
- Run the expanded native Windows gate, fix any failures, and publish a new installer only after it passes.
- Refresh the download page and screenshots to the new validated release and update the feature checklist's build-specific evidence.
- Verify live Cloud sign-in, invitation delivery, group/profile grants, synchronization, device revocation and remote MCP against an accessible compatible service.
- Publish through Sites and verify `gamebrowser.fiam.dev` DNS and HTTPS through Cloudflare when those tools are available.
- Configure a GameBrowser signing key before producing signed update manifests.

No live invitations or emails are sent by these tests. Custom-domain connectivity and hosted Cloud availability remain unverified.
