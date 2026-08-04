# Publishing Trae Use Token

TRAE CN 1.107.1 uses Visual Studio Marketplace for extension search and Open VSX for extension
assets. To keep the extension discoverable and installable, releases are published to both
registries by GitHub Actions.

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

## One-time Visual Studio Marketplace setup

1. Sign in to the [Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage)
   with a Microsoft account.
2. Create the publisher ID `firerlAGI`. It must match the `publisher` field in `package.json`.
3. Create an Azure DevOps personal access token with the `Marketplace → Manage` scope. During PAT
   creation, select **All accessible organizations** so the Marketplace accepts it.
4. In the GitHub repository, add the token at
   `Settings → Secrets and variables → Actions → New repository secret` with the name `VSCE_PAT`.

The token is only passed to `vsce` inside GitHub Actions. Never commit it or paste it into logs,
issues, or chat.

## Publish a version

1. Update `version` in `package.json` and `package-lock.json` and update `CHANGELOG.md`.
2. Run `npm run check` and `npm run package:vsix -- --allow-missing-repository` locally.
3. Commit and push the release.
4. Create and push a tag matching the package version, for example `v1.3.0`.

The GitHub workflows verify the tag, run all tests, create the Open VSX namespace when needed, and
publish the same version to Open VSX and Visual Studio Marketplace. `workflow_dispatch` can be used
for the first publication or a manual retry; duplicate versions are skipped by the Marketplace
workflow.
