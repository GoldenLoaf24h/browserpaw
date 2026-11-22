# Releasing BrowserPaw

This is the release procedure. [TEMPLATE.md](./TEMPLATE.md) owns the body format; [QUALITY.md](../QUALITY.md) owns verification. Historical version notes remain frozen.

## Format and evidence

- Use the exact GitHub title `BrowserPaw vX.Y.Z` and H1 `# BrowserPaw vX.Y.Z`, including a prerelease suffix when applicable. Put the summary under Overview.
- Keep the leading v4.x migration callout at the top of `## Overview` for v5.x releases, directing users upgrading from BrowserPaw v4.x to ask their AI Agent to read `docs/MIGRATION.md` (or `docs/MIGRATION.zh-CN.md`) and run the migration.
- Keep one English note at `docs/releases/vX.Y.Z.md`. Its Tag must match the filename and title. Target identifies the release branch; Date is the release date in ISO format.
- Use the template's six sections once, in order. Record breaking changes, migration instructions, compatibility, tests, CI, loaded runtime checks and exclusions explicitly. Use "None" or "Not tested: reason" when accurate.
- GitHub owns draft/published status; do not duplicate a mutable status in the version note.
- Do not leave placeholders, TODO markers or raw HTML in version notes. Do not prefill passing results, invented counts or performance claims.
- Keep stable assets `browserpaw-extension.zip` and `browserpaw-skill.zip`. The tag, package versions and embedded build metadata identify the version.
- `pnpm release:check` validates structure, metadata, version agreement, required asset references, compare links and unresolved placeholders. It does **not** prove test results, artifact checksums or successful publication.
- The checker exempts a fixed historical filename list, including the old v3.3.0 draft. It does not exempt every version below the current version. Use `--file` to check any file explicitly without rewriting history.

## Prepare the release

1. Review the changes since the preceding published tag. Reconcile package and manifest versions, client mirrors and install instructions; use the repository's existing build and synchronization commands.
2. Copy TEMPLATE to the new version note, fill it from observed evidence, register it in the [release ledger](./README.md), and move only included entries out of [unreleased.md](./unreleased.md). Leave unfinished changes in the ledger.
3. Run focused tests during preparation. Update the note with actual results and explicit exclusions, then run the final gate below. Any subsequent tracked source or documentation change requires a fresh final gate.
4. Follow QUALITY for browser acceptance of changed browser behavior. A docs-only change does not require deployment. If loading an extension is needed, stage all artifacts before one manual reload and verify the loaded build identity.
5. Use the version note as the sole source of the GitHub body via `--notes-file`. Do not use generated notes or paste an unrelated summary into the web editor.

Run from the repository root:

```powershell
$releaseTag = 'vX.Y.Z' # Replace with the real version before running any command.
$releaseNote = "docs/releases/$releaseTag.md"
pnpm release:check
node scripts/release-notes.mjs --file $releaseNote
pnpm verify
```

Stop on any nonzero exit. Preserve the generated verification report unchanged. Configure extension synchronization only when deployment is intended; building is not permission to deploy.

## Commit, CI and tag

Commit and push only within the authorized task. Use a clean release checkout and do not include unrelated work. Require CI for the exact source commit to pass on Linux, Windows and macOS.

Create and push the annotated tag on that verified commit. Wait for the tag-triggered CI workflow to pass on all three platforms before publishing.

```powershell
git tag -a $releaseTag -m "BrowserPaw $releaseTag"
git push origin $releaseTag
git rev-parse "$releaseTag^{commit}"
gh run list --workflow ci.yml --commit (git rev-parse "$releaseTag^{commit}")
```

Check that local HEAD, the remote tag and the successful CI head SHA agree. If source changes, repeat verification and CI before creating the tag; do not move a published tag.

## Package the verified output

`pnpm verify` already builds the extension. Package that verified output to preserve its exact artifact hashes. The build ID is stable for unchanged extension inputs, while build timestamps and archive hashes can differ between runs.

The following pwsh example creates a new local directory for this version and packages the existing build. If it already exists, inspect its contents rather than overwriting a frozen release. Run commands separately and stop on errors.

```powershell
$releaseDir = Join-Path 'releases' $releaseTag
if (Test-Path -LiteralPath $releaseDir) { throw "Inspect existing release directory: $releaseDir" }
New-Item -ItemType Directory -Path $releaseDir -ErrorAction Stop | Out-Null
Compress-Archive -Path 'app/chrome-extension/.output/chrome-mv3/*' -DestinationPath "$releaseDir/browserpaw-extension.zip" -ErrorAction Stop
Compress-Archive -LiteralPath 'skills/browserpaw' -DestinationPath "$releaseDir/browserpaw-skill.zip" -ErrorAction Stop
Get-FileHash "$releaseDir/browserpaw-extension.zip", "$releaseDir/browserpaw-skill.zip" -Algorithm SHA256
```

Inspect both archives: the extension must contain `manifest.json` and `browserpaw-build.json` at its root; the skill must contain `browserpaw/SKILL.md` plus its referenced resources. Do not include local configuration, API keys, caches or developer instruction files. Confirm the embedded version and build ID against the verification report.

From `app/native-server`, run `npm pack --json --pack-destination ABSOLUTE_RELEASE_DIR`. Inspect the resulting `browserpaw-X.Y.Z.tgz` and include it alongside the two ZIPs in `SHA256SUMS.txt`. Run the isolated browser fixture against the CLI extracted from that tarball.

Keep computed SHA-256 values with local release evidence. Do not put build-dependent hashes into tracked notes and trigger a build/hash/rewrite loop. Compare local and downloaded draft assets before publication.

## Create and inspect a draft

A release task must authorize remote creation and publication. Existing authorization suffices; do not ask for it again. This guide and its checks do not themselves grant publication permission.

```powershell
gh release create $releaseTag "$releaseDir/browserpaw-extension.zip" "$releaseDir/browserpaw-skill.zip" "$releaseDir/browserpaw-$($releaseTag.TrimStart('v')).tgz" "$releaseDir/SHA256SUMS.txt" --verify-tag --draft --title "BrowserPaw $releaseTag" --notes-file $releaseNote
gh release view $releaseTag --json tagName,name,body,isDraft,isPrerelease,targetCommitish,assets
```

For a prerelease tag, add `--prerelease --latest=false` to creation and keep `--latest=false` when publishing. For a stable release, decide explicitly whether it should become latest.

Before publication:

- Inspect Markdown rendering and compare the title/body with the canonical file.
- Verify the remote tag resolves to the tested commit and all three CI platforms passed for it.
- Confirm exactly the intended assets are attached with the stable names.
- Download the draft assets into a new local directory with `gh release download $releaseTag --dir <new-directory>` and compare all three package hashes with the local checksum file.
- Confirm the verification scope describes the packaged build and states every untested boundary. If a new build was required, repeat affected runtime checks.

Once the authorized release is ready:

```powershell
gh release edit $releaseTag --draft=false --latest=true
gh release view $releaseTag --json url,tagName,name,isDraft,isPrerelease,assets
```

Confirm the release is public and its extension ZIP can be downloaded before making the matching CLI version available on npm's `latest` tag. The update notice directs users to that ZIP. Keep any corrections to the canonical release note and public release body in sync.

Publish the tested npm tarball before distributing the matching DeepSeek Harness, Hermes, Claude Code and Codex plugin releases. Their installation instructions depend on the CLI being available.

## Automation boundary

CI runs `pnpm release:check` on pushes and pull requests, and `pnpm verify` exercises the checker tests. This repository does not automatically publish a release. Formatting checks complement the explicit review of evidence, tag identity and assets.

Reference: [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create), [GitHub release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).
