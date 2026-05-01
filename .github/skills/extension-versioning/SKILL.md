---
name: extension-versioning
description: "Use when: versioning the bundled controller extension VSIX, bumping packages/controller-extension/package.json, updating extension version history/changelog, auto-incrementing semver, preparing controller VSIX releases."
---

# Extension Versioning

Use this skill whenever a task asks to version, bump, release, package, or track
the bundled controller extension VSIX in this repository.

## Versioned Artifacts

The controller extension version is independent from the CLI package version.
Do not force root, CLI, and controller package versions to match.

- `packages/controller-extension/package.json`
- matching entries in `package-lock.json`
- `extension-version-history.json`
- `CHANGELOG.md`

The version represents the bundled controller extension VSIX installed by
`vscode-ext-test install-testing-extension-to-vscode` and `vscode-ext-test install-testing-extension-to-profiles`.

Whenever a functional change touches `packages/controller-extension/**`, bump
the controller extension version before final packaging. CLI-only changes do not
require a controller extension bump.

## Required Workflow

1. Inspect the requested change and choose a semver bump:
   - `patch` for controller extension fixes or hardening
   - `minor` for new controller extension capabilities or protocol additions
   - `major` for breaking controller extension protocol or activation changes
   - explicit `x.y.z` only when the user asks for a specific version
2. Run a dry run first:
   ```bash
   npm run version:extension -- patch --dry-run --note "short release note"
   ```
3. Run the real bump:
   ```bash
   npm run version:extension -- patch --note "short release note"
   ```
4. Verify the changed files and run the relevant build/tests for the release scope.
5. Do not hand-edit controller extension versions or history unless the versioning script is broken.

## Notes

- The controller extension version can differ from `package.json` and
   `packages/cli/package.json`.
- The script appends history and rewrites the Markdown history from the JSON
  source of truth.
- Release tags must still match `packages/cli/package.json`; the release workflow
   enforces that separately and does not require the controller VSIX version to match.
