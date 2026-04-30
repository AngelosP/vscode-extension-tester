# Changelog

This changelog records versions for the bundled controller extension VSIX.
The CLI package version is independent and may differ from the VSIX version.

Use `npm run version:extension -- <patch|minor|major|x.y.z> --note "summary"`
to update the controller extension version. The command updates
`packages/controller-extension/package.json`, package-lock metadata,
`extension-version-history.json`, and this file together.

| Version | Date | Kind | Notes |
| ------- | ---- | ---- | ----- |
| 0.1.1 | 2026-04-29 | patch | Add automated extension build versioning workflow. |
| 0.1.0 | 2026-04-29 | baseline | Baseline before automated extension build versioning. |