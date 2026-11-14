# GameBrowser — complete requested feature checklist

Checked items have been verified in the named build or surface. **Windows beta 82 is the current published installer.** It includes the restored Live workspace and improved UI, verified through rendered-browser checks and the installed Windows release gate.

## Branding, Windows and delivery

- [x] GameBrowser product name, Windows executable and installer branding.
- [x] Developed by Solomon Gbeta, with solomon.ng attribution and preserved upstream licenses.
- [x] Source uploaded to MultilancerNG/GameBrowser on GitHub.
- [x] Windows x64 full/offline and slim installers, with SHA-256 checksums.
- [x] Beta 82 passed fresh installed-app startup, Local mode, Local MCP, agent discovery, Live workspace/browser controls, shutdown and uninstall checks.
- [x] Cyber-style download landing page and direct installer download.
- [x] Removed landing-page GitHub/source navigation links.
- [x] Updated the download page with the included Live workspace functions, setup steps, FAQs, full/slim installer links and compatible Cloud service requirements.
- [x] GitHub Pages deployment of the download page.
- [ ] Publish the prepared site through Sites.
- [ ] Assign and verify gamebrowser.fiam.dev through Sites and Cloudflare, including HTTPS.

## Profiles and separate identities — available in beta 82

- [x] Local mode without an account or AliasMode Cloud connection; profile data stays on the computer.
- [x] Separate profile browser directories, cookies, storage and saved identity settings.
- [x] New-profile fingerprint seed collision checks, including profiles in Trash.
- [x] Preserve supplied identities and sessions when importing full profile exports.
- [x] Bulk selection and recoverable multi-profile deletion, Trash restoration and permission-aware purge.
- [x] Desktop and mobile-sized viewport presets, editable on existing profiles; custom dimensions.
- [x] Per-device saved order, drag/drop and keyboard rearrangement in the profile list.
- [x] Most recently selected profile appears first in the profile list.
- [x] Import readable TXT, CSV, JSON and XLSX exports or supported pasted account data.
- [x] Export one profile, selected profiles or the current filtered view.
- [x] TXT/XLSX preserve supported identity, cookies and session data; CSV exports supported account credentials.
- [x] Cloud export requires edit access to every exported profile.

## Admin, followers and sessions — available in beta 82 profile list

- [x] Explicit Admin profile selector, with violet Admin and teal Follower role styling.
- [x] Chromium Admin controls Chromium or Firefox followers using one mirroring worker.
- [x] Mirror supported clicks, typing, keyboard, select/checkbox changes, scrolling and navigation while retaining separate sessions.
- [x] Optional Auto-follow Admin selection; other selected profiles become followers automatically.
- [x] Automatic following starts off; Stop disables the automatic option.
- [x] Clicking/deselecting a follower leaves assignments intact by default; explicit Apply/Stop changes the group.
- [x] Save, forget and explicitly resume a following group after an app restart.
- [x] Retain assignments when browser profiles close and reconnect after they reopen.
- [x] Reconnection sends future actions only, without replaying old clicks or submissions.
- [x] Stop following detaches mirroring without closing the browser profiles.
- [x] Account/access changes require current authorization before control resumes.

## Browser settings — available in beta 82 profile editor

- [x] RAM budget, MB: Auto or manual target from 128 to 32768 MB.
- [x] Auto target uses available memory and counts running/reserved/concurrent profile starts.
- [x] Optional Auto optimize applies supported renderer heap/cache settings at the next fresh launch.
- [x] Settings are device-local; saving does not close running browsers or change following assignments.
- [x] Per-profile bookmarks-bar preference, including Always show and preservation of existing behavior.
- [x] Existing bookmark folders and unrelated browser preferences are preserved.

These RAM values are soft targets, not a cap on total browser-process memory or a physical RAM reservation. Chromium's heap limit can be visible to websites. Mobile-sized presets change dimensions; they do not emulate a mobile OS or touch hardware.

## Live workspace — shipped in Windows beta 82

- [x] Make Live workspace prominent in GameBrowser and open it after the Local/Cloud setup flow.
- [x] Restore live browser tiles with real frames, running state and per-profile controls.
- [x] Restore Full Admin View and return-to-grid navigation.
- [x] Restore independent address bar, back/forward, reload/stop, tabs and fullscreen controls.
- [x] Restore explicit Admin/Follower/Manual controls and user-requested pause/manual takeover.
- [x] Use the existing trusted mirroring controller to avoid duplicate follower actions.
- [x] Keep follower assignments through tile selection, browser disconnects and navigation.
- [x] Expose optional automatic Admin following, save/resume and Stop in the Live workspace.
- [x] Drag/drop saved tile order, selected-first focus and distinct Admin/Follower borders.
- [x] Expose full profile import/export clearly, separately from configuration-only templates.
- [x] Restore groups, tags, notes, bookmarks and configuration copies into fresh identities.
- [x] Restore task manager, live CPU/RAM measurements and ownership-checked Stop/Force close.
- [x] Expose automatic RAM/optimization/bookmarks settings in the workspace profile settings.
- [x] Make desktop/mobile presets and custom sizes editable in the restored workspace.
- [x] Restore Direct/System/Proxy routes and saved proxy management.
- [x] Restore local Chromium extensions and Firefox XPI add-ons, with assignment and browser UI support.
- [x] Restore bounded local workflows, outputs and schedules while the app remains open.
- [x] Preserve current Cloud authorization, sharing and MCP functionality alongside the workspace.
- [x] Improved, consistent GameBrowser UI with legible controls, clear navigation and responsive layouts.
- [x] Verify real browser frames, tabs, roles and follower actions through the rendered workspace.
- [x] Installed Windows beta 82 Live checks: Firefox frames/input/tabs, exact Admin/Follower colors, mixed Chromium Admin / Firefox Follower actions, Stop keeping both browsers alive and follower reopening.
- [x] Pass normal desktop shutdown, sidecar cleanup and uninstall, then publish the validated installer.

## Cloud, sharing, MCP and agents

- [x] Restored optional compatible Cloud client: verified-account sign-in and shared workspaces.
- [x] Portable encrypted profile synchronization and device access/revocation client controls.
- [x] Group/folder and profile view/edit grants with admin-only access changes.
- [x] Invite members shortcuts from group/profile access to Settings → Team.
- [x] Invite/share flows tested against mocked Cloud responses; no live invitations sent by QA.
- [x] Local MCP tools and installed agent-client discovery verified on Windows.
- [x] Remote MCP connector and agent-client integration code retained.
- [ ] Verify live Cloud sign-in, invitation delivery, sharing, sync and device revocation against an accessible compatible service.
- [ ] Verify remote MCP and agent clients against that live service.
Cloud creation, identity editing and sharing use the existing Profiles/Settings management surfaces. Live workspace lists controllable edit-granted Cloud profiles and uses the Cloud coordinator for their browser lifecycle; view-only profiles remain available in Profiles.

## Validation and remaining external setup

- [x] Real Chromium following checks, including independent cookies and no replay after reconnect.
- [x] Actual TXT/XLSX export→import checks preserve identity, credentials, cookies, localStorage and tabs.
- [x] Beta 82 source regression: 2,393 passed, 11 skipped; real WebSocket shutdown tests preserve active HTTP/lifecycle work, owned agent cleanup and browser capture ordering.
- [x] Rendered desktop/mobile UI, actual source navigation, recoverable Trash and profile controls verified.
- [x] Independent Local protocol acceptance: 11 real-browser checks, including exact-once following and saved session restore.
- [x] Independent Cloud boundary acceptance: 7 checks with real browsers and a simulated service, including transient network recovery, revocation and account isolation.
- [x] Visual concept comparison completed for Live grid and Full Admin View, with functional deviations documented.
- [x] Publish the validated Windows beta 82 installer and update the download page with its included UI and functions.
- [ ] Configure a GameBrowser signing key before publishing signed in-app update manifests.

The hosted Cloud backend is separate from the public desktop source. Sites/Cloudflare tools are unavailable in this session, and the custom domain is unverified. A network-access draft was saved but has not been applied; it requires review/save and Publish in Environment settings. No credentials were added to chat or source.
