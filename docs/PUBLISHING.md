# Publishing Trae Use Token

The TRAE CN extension gallery downloads extensions from Open VSX. Publishing is automated by
`.github/workflows/publish-open-vsx.yml` after the one-time setup below.

## One-time Open VSX setup

1. Sign in to <https://open-vsx.org> with the GitHub account linked to `firerlAGI`.
2. Link the matching Eclipse account and accept the Open VSX Publisher Agreement.
3. Create an access token in <https://open-vsx.org/user-settings/tokens>.
4. In the GitHub repository, add the token at
   `Settings → Secrets and variables → Actions → New repository secret` with the name
   `OPEN_VSX_TOKEN`.

The workflow checks the `firerlAGI` namespace and creates it automatically with the official
`ovsx` CLI when it does not exist.

Never commit or paste the token into an issue, log, or chat.

## Publish a version

1. Update `version` in `package.json` and `package-lock.json` and update `CHANGELOG.md`.
2. Run `npm run check` and `npm run package:vsix -- --allow-missing-repository` locally.
3. Commit and push the release.
4. Create and push a tag matching the package version, for example `v1.3.0`.

The GitHub workflow verifies the tag, runs all tests, creates the publisher namespace when needed,
packages the extension, and publishes it to Open VSX. `workflow_dispatch` can be used for the first
publication or a manual retry of the same unpublished version.
