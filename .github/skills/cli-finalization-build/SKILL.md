---
name: cli-finalization-build
description: "Use when: finalizing a fix or feature in vscode-extension-tester, rebuilding CLI dist, rebuilding the bundled controller VSIX, packaging release artifacts, and verifying vscode-ext-test install-into-project/install-testing-extension-to-profiles deploy the latest assets to other projects."
---

# CLI Finalization Build

Use this skill whenever a fix or feature is done and the user needs the local
`vscode-ext-test` CLI package to be immediately usable from other projects.

## Artifact Contract

The CLI package must ship all three current artifacts:

- `packages/cli/dist/**`: compiled CLI runner code used by `bin/vscode-ext-test.js`
- `packages/cli/src/skill/SKILL.md`: the skill deployed by `vscode-ext-test install-into-project`
- `packages/cli/assets/controller-extension.vsix`: the controller extension installed by `vscode-ext-test install-testing-extension-to-vscode` and `vscode-ext-test install-testing-extension-to-profiles`

`vscode-ext-test install-into-project` overwrites `.github/skills/e2e-test-extension/SKILL.md`
in the target project from `packages/cli/src/skill/SKILL.md` inside the package.

`vscode-ext-test install-testing-extension-to-vscode` and `vscode-ext-test install-testing-extension-to-profiles` install the bundled VSIX
from `packages/cli/assets/controller-extension.vsix`.

The controller extension VSIX version is independent from the CLI package
version. Whenever a functional change touches `packages/controller-extension/**`,
use the `extension-versioning` skill to bump `packages/controller-extension/package.json`
before rebuilding the VSIX.

## Required Workflow

1. Run the focused tests for the change, then build the CLI and controller:
   ```powershell
   npm run build -w packages/controller-extension
   npm run build -w packages/cli
   ```
2. If `dotnet/` or native UI automation changed, rebuild the native bridge too:
   ```powershell
   npm run build:native
   ```
3. Repackage the local CLI artifact after all builds finish:
   ```powershell
   npm run package:release
   ```
4. Verify the built CLI starts from its package bin:
   ```powershell
   node packages/cli/bin/vscode-ext-test.js --version
   ```
5. Install the freshly packed tarball into the CLI source that local/manual
   smoke tests will use, then verify the PATH-resolved command is the fresh
   version. Do not use `node packages/cli/bin/vscode-ext-test.js` as a
   substitute for this check when validating local/global use.
   ```powershell
   $manifest = Get-Content release-artifacts/release-manifest.json | ConvertFrom-Json
   npm install -g ".\release-artifacts\$($manifest.tarball)"
   vscode-ext-test --version
   vscode-ext-test --help
   ```
6. Verify the local release tarball exists and includes the expected assets:
   ```powershell
   Get-Content release-artifacts/release-manifest.json
   Get-Content release-artifacts/SHA256SUMS.txt
   ```

## Smoke Test Contract

When the user asks whether the latest CLI is ready for other projects, verify
these two behaviors before answering yes:

- `vscode-ext-test install-into-project` deploys the exact latest `packages/cli/src/skill/SKILL.md`
  into `.github/skills/e2e-test-extension/SKILL.md` in the target project.
- `vscode-ext-test install-testing-extension-to-profiles` installs the exact latest
  `packages/cli/assets/controller-extension.vsix` into VS Code and every named
  vscode-extension-tester profile.

For a local package smoke test, install the freshly packed tarball first using
the tarball name from `release-artifacts/release-manifest.json`:

```powershell
$manifest = Get-Content release-artifacts/release-manifest.json | ConvertFrom-Json
npm install -g ".\release-artifacts\$($manifest.tarball)"
```

Then run the user-facing commands from a separate test project:

```powershell
vscode-ext-test install-into-project
vscode-ext-test install-testing-extension-to-profiles
```

If `vscode-ext-test --version` still reports an older version after install,
inspect `Get-Command vscode-ext-test -All` and refresh the executable source
that appears first on PATH before running smoke tests.

## Final Answer Checklist

Before telling the user the CLI is ready, report:

- which build commands ran
- which tests ran
- whether `release-artifacts/*.tgz` was regenerated
- whether the PATH-resolved `vscode-ext-test` was refreshed from that tarball
- whether the install-into-project skill and profile-install VSIX smoke contract was verified or not

Do not say other projects will get the latest until the global/package install
source they use has been refreshed from the regenerated tarball.