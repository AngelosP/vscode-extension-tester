---
name: extension-versioning
description: "Use when: versioning VS Code extension builds, bumping release versions, updating extension version history/changelog, auto-incrementing semver, preparing controller VSIX or CLI releases."
---

# Extension Versioning

Use this skill whenever a task asks to version, bump, release, package, or track
the built VS Code extension artifacts in this repository.

## Versioned Artifacts

Keep these versions synchronized:

- `package.json`
- `packages/cli/package.json`
- `packages/controller-extension/package.json`
- matching entries in `package-lock.json`
- `extension-version-history.json`
- `CHANGELOG.md`

The version represents the build artifacts produced by this repo: the CLI npm
package, the bundled controller extension VSIX, and release artifacts.

## Required Workflow

1. Inspect the requested change and choose a semver bump:
   - `patch` for fixes, test/framework hardening, documentation-only release prep
   - `minor` for new commands, new test capabilities, new user-facing workflows
   - `major` for breaking CLI behavior or incompatible artifact layout changes
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
5. Do not hand-edit package versions or history unless the versioning script is broken.

## Notes

- The script refuses to bump when package versions are out of sync.
- The script appends history and rewrites the Markdown history from the JSON
  source of truth.
- Release tags must still match `packages/cli/package.json`; the release workflow
  enforces that separately.
