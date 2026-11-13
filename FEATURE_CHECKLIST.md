# GameBrowser feature checklist

This distinguishes implemented desktop code from live-service and release validation. Windows beta 78 is published and has passed its installed Windows smoke check, including Local MCP initialization, tool listing and agent discovery. The download page points to its verified full installer.

## Implemented and verified in source

- [x] GameBrowser branding and Solomon Gbeta / solomon.ng attribution.
- [x] Local mode without an account or AliasMode Cloud connection.
- [x] Restored optional Cloud client, account verification, workspace sync and device controls.
- [x] Profile/folder view/edit grants and admin-only grant changes.
- [x] Bulk selection, recoverable deletion to Trash, restoration and permission-aware purge.
- [x] Separate profile directories, persisted identities and new-profile fingerprint seed collision checks.
- [x] Desktop and mobile-sized screen presets editable on existing profiles.
- [x] Per-device manual order, drag handles, keyboard movement and selected-first focus.
- [x] Distinct violet Admin and teal Follower role styling.
- [x] Local MCP helper, remote connector and agent client integration code.
- [x] Group/profile sharing shortcuts to Settings → Team invitation controls (UI tested with mocked Cloud).
- [x] Explicit browser action following: Chromium Admin, Chromium or Firefox followers.
- [x] Real Chromium tests for click, input, checkbox/select, keyboard, navigation and independent cookies.
- [x] Trusted-event capture isolated from website scripts, bounded queues and visible follower errors.
- [x] Stop detaches mirroring without closing the browser profiles.
- [x] Cyber download page, direct Windows download, source links/features section removed as requested.
- [x] Full/slim Windows installers and SHA-256 checksums published for beta 78.
- [x] Published beta 78 passed a fresh Windows install/start/Local-mode/helper/shutdown/uninstall check.
- [x] Installed Windows Local MCP initialization, tools/list, and agent discovery passed.
- [x] Current dashboard layout and existing controls retained.
- [x] Import supported TXT/CSV/JSON/XLSX profile exports or pasted account data.
- [x] Discoverable export controls for one profile, selected profiles or the filtered view.
- [x] TXT/XLSX identity and cookie exports; CSV account credentials, with Cloud edit checks.

## Latest published desktop release: Windows beta 78

- [x] Freeze sync assignments by default when a follower is clicked; explicit Apply selection/Stop.
- [x] Optional Auto-follow Admin selection; automatically apply other selected profiles as followers.
- [x] Auto-follow starts off and turns off on Stop or account/workspace changes.
- [x] Save/forget/resume sync groups by authorized account without storing browser credentials.
- [x] Retain groups while browsers are closed and reconnect future actions when profiles reopen.
- [x] Full regression: 2,107 passed, 10 skipped; focused final UI/API/selection tests passed.
- [x] Browser QA covers rapid Admin changes, pending Stop, Firefox followers and import/export roundtrips.
- [x] Beta 78 full/slim installers built and installed Windows smoke passed.
- [x] Beta 78 Windows build, installed-app validation and publication completed; download updated.

## Browser settings included in Windows beta 78

- [x] Device-local resource policy API with Auto/manual RAM targets and Cloud edit authorization.
- [x] Opt-in heap/cache optimization on new launches; existing browsers and identities retained.
- [x] Bookmarks-bar engine preferences and preservation of existing bookmark folders.
- [x] Browser settings controls verified in light/dark/mobile layouts, including persistence and errors.
- [x] Saving settings leaves running browsers, following groups and unsaved profile edits intact.
- [x] Auto allocation accounts for concurrent profile starts as well as running browsers.

RAM settings are soft heap/cache targets, not total-process memory caps. They apply at the next fresh launch and are device-only.

## Requires external access or configuration

- [ ] Live Cloud account, sharing, synchronization and device-revocation checks.
- [ ] Live remote MCP/agent end-to-end checks against a compatible Cloud service.
- [ ] Sites publication using an available Sites publishing connection.
- [ ] Configure/confirm gamebrowser.fiam.dev through Sites and Cloudflare, including HTTPS.
- [ ] Configure a GameBrowser signing key before publishing signed in-app update manifests.

The Cloud service is separate from the public desktop source. Sites and Cloudflare tools are not available in this session, so the domain is not confirmed connected. A network-access draft has been saved for review but is not applied; the environment needs review/save and Publish before the permitted live checks can be retried. No secrets were added. Mobile-sized presets change dimensions; they do not emulate a mobile operating system or touch hardware.
