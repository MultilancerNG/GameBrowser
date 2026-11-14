# Historical beta 82 Live workspace integration

**Historical record:** this page describes the mounted-host architecture shipped in Windows beta 82. The independent GameBrowser upgrade replaces that approach; see [Independent StakeMode upgrade](INDEPENDENT-STAKEMODE-UPGRADE.md) for the current architecture and pending release gates. Statements below apply to beta 82, not the new standalone source.

The original workspace was supplied as `AliasMode-Game-stakemode-v0.1.0-preview.2.zip`, SHA-256 `0cfee5999afba003ca10a731ee8ae9e1d6ef26f3b40d4258c33aeab1a9094776`. Its package identifies StakeMode `0.1.0-preview.2`; its provenance document identifies AliasMode base commit `3830cc4f8350b3b21e57dc962a182e7bdfdb3f05`. Those are properties of the supplied archive, not a claim that its historical release was independently verified.

GameBrowser retains its current application entry point, identity store, verified browser launcher, Cloud coordinator, Local MCP and agent runtime. The restored `workspace/` application is mounted on the existing loopback origin. It does not replace the application with the archive's separate local-only `StakeMode-cli.ts` entry point.

## Ownership and synchronization

- Browser processes remain owned and generation-checked by the current launcher.
- The browser bridge renders live frames and provides tabs, navigation and explicit manual controls.
- The existing trusted Node mirroring worker is the single Admin→Follower action controller. The legacy extension's duplicate capture/replay path is disabled for that controller.
- Following assignments survive view selection and browser disconnects. Explicit role, pause and Stop commands change control; reconnect never replays old queued actions.
- Workspace origin/pacing settings are applied through the controller, rather than being decorative UI state.
- Cloud profile access is checked against the current authoritative roster. Cached identities are not evidence of authorization. Existing Cloud Profiles and Settings remain available through explicit navigation for management that requires the current coordinator.

## Data and runtime compatibility

The GameBrowser installation keeps its existing application identifier and state directory. This integration does not silently move or delete another StakeMode installation's data. Full profile exports and configuration-only templates are distinct import formats: full exports can retain supported identity/session data; template copies create fresh identities.

RAM targets are advisory renderer/cache settings, not whole-browser memory limits. Resource monitoring defaults to notification; only an explicitly selected budget action may pause or stop a profile. Browser settings apply on the next fresh launch.

Mobile-sized presets change saved dimensions while retaining the profile's operating system, user agent, identity seed and session. Scaling a live tile is separate from changing the profile's dimensions.

The Windows package includes the workspace assets, local Inter font/license, sync extension and browser workers. The Firefox add-on compatibility patch is adapted to the currently pinned Firefox 156 runtime, with exact module hashes and notices; it does not replace the verified native executable with the archive's older runtime.

## Release acceptance

The checklist in `FEATURE_CHECKLIST.md` records user requirements and their status. Before release, the Windows workflow must render the installed Live workspace and exercise a real bundled Firefox profile: live frame, manual input, tabs, navigation and orderly shutdown. Source type checks or an empty health endpoint do not establish that the installed workspace works.
