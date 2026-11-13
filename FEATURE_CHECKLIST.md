# GameBrowser feature checklist

This distinguishes implemented desktop code from live-service and release validation. Windows beta 76 is published; the newer mirroring/session changes below are being prepared for the next beta.

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
- [x] Full/slim Windows installers and SHA-256 checksums published for beta 76.
- [x] Published beta 76 passed a fresh Windows install/start/Local-mode/helper/shutdown/uninstall check.
- [x] Installed Windows Local MCP initialization, tools/list, and agent discovery passed.
- [x] Current dashboard layout and existing controls retained.

## Implemented for the next beta; release validation pending

- [x] Freeze sync assignments when a follower is clicked; require explicit Apply selection/Stop.
- [x] Save/forget/resume sync groups by authorized account without storing browser credentials.
- [x] Retain groups while browsers are closed and reconnect future actions when profiles reopen.
- [x] Full regression: 2,081 passed, 10 skipped; separate real Chromium mirroring tests passed.
- [ ] Package and validate the next Windows beta with the new sync/session features.

## Newly requested and pending

- [ ] Automatic per-profile RAM budget in MB, with Auto/manual targets and clear enforcement scope.
- [ ] Optional automatic memory optimization, preserving stored identity/session data.
- [ ] Per-profile **Always show bookmarks bar** control, preserving existing browser UI behavior.

## Requires external access or configuration

- [ ] Live Cloud account, sharing, synchronization and device-revocation checks.
- [ ] Live remote MCP/agent end-to-end checks against a compatible Cloud service.
- [ ] Sites publication using an available Sites publishing connection.
- [ ] Configure/confirm gamebrowser.fiam.dev through Sites and Cloudflare, including HTTPS.
- [ ] Configure a GameBrowser signing key before publishing signed in-app update manifests.

The Cloud service is separate from the public desktop source. Sites and Cloudflare tools are not available in this session, so the domain is not confirmed connected. Mobile-sized presets change dimensions; they do not emulate a mobile operating system or touch hardware.
