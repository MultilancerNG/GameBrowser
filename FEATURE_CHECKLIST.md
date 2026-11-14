# GameBrowser — requested features and independent StakeMode upgrade

**Published download: Windows beta 82. Independent upgrade: source work in progress; new Windows installer verification and publication are pending.** Beta 82 passed its installed checks, but its mounted workspace is the architecture being replaced. Downloading beta 82 does not install the standalone changes below.

For the independent-upgrade sections, `[x]` means the feature is implemented in source. `[ ]` means work or verification remains. Source implementation and old release evidence are not proof that the new installer has shipped. See [the independent upgrade guide](docs/INDEPENDENT-STAKEMODE-UPGRADE.md) for provenance, architecture and required release evidence.

## Independent project and UI — source

- [x] Keep the GameBrowser product name, Solomon Gbeta attribution and upstream licenses.
- [x] Upgrade the original StakeMode standalone architecture with its own `GameBrowser-cli.ts`, runtime, profile store, workspace and settings.
- [x] Desktop entry opens the own Live workspace; the normal sidecar entry does not run the legacy AliasMode CLI, React dashboard or mounted-host adapter.
- [x] Keep the approved dark UI, sidebar, compact metrics, live grid and Full Admin View.
- [x] Retain desktop/mobile layouts, full browser view, fullscreen and return-to-grid controls.
- [x] Provide own profile management and Settings instead of redirects into the legacy host.
- [ ] Finish rendered desktop/mobile verification of every new management and Settings flow.
- [ ] Capture and publish new installed-software screenshots after the standalone Windows gate passes.

## Admin, followers and sessions — source

- [x] Select an explicit Admin; show violet Admin and teal Follower borders independently of selection.
- [x] Restore Firefox Admin as well as Chromium Admin, with mixed-engine followers.
- [x] Keep one authenticated capture/replay controller for each following session.
- [x] Preserve the original 256-profile workspace: one Admin and up to 255 distinct followers, with bounded visible streams and launch concurrency.
- [x] Mirror supported safe clicks, typing, keyboard, select/checkbox changes and scrolling while retaining separate browser identities and sessions.
- [x] Follow approved explicit address navigation, reload, new tab, tab selection and tab close in either engine direction.
- [x] Starting, resuming or reconnecting seeds the existing page state without replaying past navigation or past actions.
- [x] Clicking or deselecting a follower edits the draft selection without disconnecting it or changing assigned roles.
- [x] Apply selection, Manual, Pause, Reconnect and Stop remain explicit controls.
- [x] Retain assigned roles through browser disconnect/reopen; automatic transport recovery forwards future actions only.
- [x] Keep the existing independent manual boundary for sensitive authentication and financial controls.
- [x] Save, forget and explicitly resume the exact following group after closing/reopening the application.
- [x] Stop following keeps the exact browser processes open.
- [x] Optional Auto-follow Admin selection; it starts off and Stop disables it.
- [x] Drag/drop and keyboard rearrangement with per-device saved order.
- [x] Move the most recently selected profile first, as clarified by the user; selection does not silently replace Admin.
- [ ] Pass the expanded installed mixed-engine, Firefox Admin, navigation/tab, saved-session and reconnect checks on the new build.

## Profiles, imports, exports and existing data — source

- [x] Local mode without an account; separate browser data directories, cookies, storage and identities.
- [x] Create/edit isolated profiles, bulk create, groups, tags, notes and saved bookmarks.
- [x] Check fingerprint seed collisions, including profiles in Trash.
- [x] Import TXT, CSV, JSON and XLSX full-profile exports or supported pasted account data.
- [x] Export one profile, selected profiles or the current filtered view.
- [x] Preserve supported identity/session fields in full exports; supported CSV account fields and richer TXT/XLSX exports remain distinct formats.
- [x] Keep configuration-only templates and fresh-identity profile copies separate from full identity/session imports.
- [x] Recoverable bulk Trash, restore and permission-aware permanent purge.
- [x] Preserve the existing GameBrowser application/state directory and detect beta 82 scoped workspace metadata.
- [x] Restore original TypeScript/Python `StakeModeClient` SDKs and additive `GameBrowserClient` aliases, with both API guides included in the package.
- [x] Keep the original authenticated local REST contract and port 8080 default; a busy port fails visibly rather than adopting another service.
- [x] Detect original StakeMode data and offer an explicit, validated offline state-copy/import workflow; preserve source files and reject unsafe or conflicting destinations.
- [ ] Verify a representative original StakeMode installation upgrade with the newly built Windows installer.

## Browser functions and resources — source

- [x] Real Chromium/Firefox browser frames, running status and per-profile controls.
- [x] Independent address bar, back/forward, reload/stop, tabs and manual input.
- [x] Desktop/mobile-sized presets and custom dimensions editable while stopped.
- [x] Preserve the launch-generation viewport and current Firefox content-size correction; viewer resizing does not resize the browser.
- [x] RAM budget, MB: Auto or a manual target from 128 to 32768 MB.
- [x] Automatic allocation uses available memory and running/reserved/concurrent profile starts.
- [x] Optional Auto optimize applies supported renderer heap/cache settings at the next fresh launch.
- [x] Resource settings remain device-local and do not close running browsers or change following assignments when saved.
- [x] Per-profile bookmarks bar, including Always show, while preserving existing folders/preferences.
- [x] Task manager with verified native CPU/RAM/process readings and ownership-checked Stop/Force close.
- [x] Direct/System/Proxy modes, saved HTTP/SOCKS proxy library and credential-redacted listings.
- [x] Local Chromium MV3 extensions and Firefox XPI add-ons, immutable imports, digest/permission review and selected website scope.
- [x] Real package popup/options views and stopped-profile disable/remove settings effective at next launch.
- [x] Bounded local read-only workflows, cancellation, JSON/CSV outputs and app-open schedules.
- [ ] Pass installed native controls, cookies, both-engine workflows, scheduling, metrics and add-on scope/UI/restart gates for the independent build.

RAM budgets are monitored targets rather than total-process memory caps or reserved physical RAM. Mobile-sized presets change dimensions without emulating another OS or touch hardware. Extension site access follows browser host-pattern rules, which do not isolate exact TCP ports.

## Optional Cloud, Team, MCP and agents — source and pending service checks

- [x] Own optional Cloud settings and verified-account sign-in client, with local profiles available without Cloud.
- [x] Cloud profile/browser lifecycle integration uses current authoritative grants and account-scoped state.
- [x] Group/folder and individual profile view/edit sharing controls.
- [x] Invite members in Settings → Team, including group/profile sharing shortcuts.
- [x] Preserve encrypted portable profile synchronization and device-access client controls.
- [x] Retain local MCP tools, private authenticated runtime transport and installed agent discovery.
- [x] Retain remote MCP connector/agent client code.
- [x] Mocked Cloud invitation/sharing checks; QA sends no live invitations or emails.
- [ ] Verify Cloud account/profile/device flows in the independently installed native app.
- [ ] Verify live Cloud sign-in, invitation delivery, group/profile grants, synchronization and device revocation against an accessible compatible service.
- [ ] Verify remote MCP and agent clients against that service.
- [ ] Pass installed Local MCP and agent discovery again for the new standalone release.

Cloud requires a compatible hosted service; shipping the desktop client does not deploy that backend. Current authorization must be refreshed before Cloud browser control; cached identities do not grant access.

## Delivery already published and next release

- [x] Publish Windows beta 82 full/offline and slim installers, with SHA-256 checksums.
- [x] Beta 82 installed gate passed Local startup, local MCP, real Firefox controls, Chromium Admin → Firefox follower, Stop retaining browsers, Firefox reopen, shutdown and uninstall.
- [x] Publish the cyber-style download page through GitHub Pages with beta 82 features, setup steps, FAQs and installer links.
- [x] Remove landing-page GitHub/source navigation links.
- [x] Prepare the new independent sidecar and SDK/API resources; retain verified Firefox 156, official Node 22 and existing viewport/shutdown fixes.
- [x] Expand Windows release gates to exercise the independent entry, both native Admin directions, following navigation/tabs, exact-once input, saved session close/reopen, sensitive manual boundary, cookies, workflows, schedules, metrics and add-ons.
- [ ] Complete final source type checks/regression checks at the immutable release commit.
- [ ] Build and install the new independent full/slim Windows packages; pass every required native gate.
- [ ] Publish the validated new installer and its checksums, then update the download page and UI images to that version.
- [ ] Publish through Sites.
- [ ] Connect and verify `gamebrowser.fiam.dev` through Sites and Cloudflare, including HTTPS.
- [ ] Configure a GameBrowser signing key before publishing signed in-app update manifests.

Sites/Cloudflare tools are unavailable in the current session, so the custom domain remains unverified. The new Windows gate is required before promotion; a source build or historical beta 82 result does not satisfy it.
