---
name: github-release-tagging
description: "Use when: shipping binary releases through the existing GitHub Actions release workflow, creating or pushing vX.Y.Z git tags, verifying release tag/package version alignment, publishing release artifacts."
---

# GitHub Release Tagging

Use this skill when the next binary release is already versioned and needs to be
shipped through the repository's existing GitHub Actions release workflow.

## Release Mechanics

- The release workflow is `.github/workflows/release.yml`.
- It runs on pushed tags matching `v*.*.*` and on manual `workflow_dispatch`.
- Tag releases must match `packages/cli/package.json`; the workflow strips the
  leading `v` from the tag and fails if it differs from the CLI package version.
- A tag-triggered run builds the native bridge, runs tests, builds the TypeScript
  packages and controller VSIX, packages `release-artifacts/*`, uploads the
  workflow artifact, and publishes the GitHub release.
- `workflow_dispatch` is useful for artifact validation, but the publish step
  only runs for tag refs.

## Required Workflow

1. Check whether the current version is already prepared:
   ```powershell
   git status --short --branch
   $version = (Get-Content packages/cli/package.json | ConvertFrom-Json).version
   $version
   git tag --list "v$version"
   git ls-remote --tags origin "refs/tags/v$version"
   ```
2. If the version has not been bumped yet, use the `extension-versioning` skill
   first. Do not bump again when the package manifests and changelog already show
   the intended unreleased version.
3. Verify the tree is clean except for intentional release-prep changes. If a
   skill, changelog, or versioning change was made as part of the shipping task,
   commit and push that change before tagging when the user has asked to ship or
   explicitly asked for commits/pushes.
4. Push `main`, then create and push the matching annotated tag:
   ```powershell
   $version = (Get-Content packages/cli/package.json | ConvertFrom-Json).version
   git push origin main
  git tag -a "v$version" -m "Release v$version"
   git push origin "v$version"
   ```
5. Verify that the GitHub Actions release run started:
   ```powershell
   gh run list --workflow Release --limit 5
   ```
   If `gh` is unavailable, give the user the Actions URL and the pushed tag name.

## Guardrails

- Never overwrite, delete, or force-push an existing release tag unless the user
  explicitly asks for a retag.
- Never tag a commit whose `packages/cli/package.json` version differs from the
  tag version.
- Prefer annotated tags for shipped releases.
- Keep release tags on `main` unless the user explicitly asks to release another
  branch or commit.