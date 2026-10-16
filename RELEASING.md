# Releasing PDF Annotator

## Initial repository setup

Publish this source in a public GitHub repository. There is currently no repository URL configured in the local Git checkout. Keep `README.md`, `LICENSE`, `manifest.json`, and `versions.json` at the repository root. Do not commit `main.js`, local `data.json`, dependencies, or `dist/`; release automation generates the installable files.

The plugin ID is `pdf-annotator`. Confirm that this ID and the display name are available in the [Obsidian Community directory](https://community.obsidian.md) before submitting; local checks cannot establish uniqueness. If a rename is needed, update the manifest, README installation folder, and documentation together.

The manifest currently requires Obsidian 1.7.2 because the plugin uses `Workspace.revealLeaf` with deferred-view support. The attachment-path API also requires at least 1.5.7. Verify compatibility in an actual app before release; API availability alone is not a complete compatibility test.

## Prepare a release

1. Complete the manual checks in [CONTRIBUTING.md](CONTRIBUTING.md), including mobile and pop-out testing if keeping `isDesktopOnly: false`. Record the Obsidian versions tested. If mobile cannot be supported, set `isDesktopOnly: true` and explain the limitation in the README.
2. Update [CHANGELOG.md](CHANGELOG.md). For the first release, the version is already `0.1.0`.
3. For later releases, run `npm version patch --no-git-tag-version` (or `minor`, `major`, or an explicit `x.y.z`). The version hook updates `manifest.json` and `versions.json`; npm updates `package.json` and `package-lock.json`. If the minimum app version changes, edit it in the manifest before running this command.
4. Run `npm run release:prepare`. It validates metadata, runs tests, builds the production bundle, and copies exactly `main.js`, `manifest.json`, and `styles.css` into `dist/`.
5. Commit the source, documentation, and version files, then push the default branch to GitHub.
6. Create and push a tag that exactly matches `manifest.json`, with no `v` prefix. For the first release:

   ```sh
   git tag 0.1.0
   git push origin 0.1.0
   ```

7. The release workflow verifies the tag, rebuilds and tests, and creates a **draft** GitHub release with the three files attached. Review its notes, add testing results and known limitations, then publish it. A draft release is not installable through Obsidian's directory.

If GitHub Actions is unavailable, create a release manually for the same tag and upload the three files from `dist/` individually. Do not rely on GitHub's automatic source archives.

## Submit to the community directory

Follow the current [official submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin), [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins), and [developer policies](https://docs.obsidian.md/community-directory/developer-policies).

Sign in to [community.obsidian.md](https://community.obsidian.md) with your Obsidian account, link the GitHub account that owns the repository, and add the plugin. The directory reads `manifest.json` from the default branch and installs the release whose tag matches its version. Address any automated review feedback in a new version and release. Only the initial publication needs a directory submission.

This repository's automation prepares release assets. It does not submit to the directory, publish a draft, or claim that app-level testing has been completed.
