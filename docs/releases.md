# Releases

`dev` is the integration branch. Merge a reviewed version change into `main` to request publication after CI passes. Wait for that run to finish before releasing another version of the same component. Publication does not bump versions or deploy a service.

## Versions and artifacts

Server and client versions are independent. Update the affected [server](../apps/server/package.json) or [client](../packages/client/package.json) manifest; engine changes affecting the server need a server version bump. Workspace and private engine versions are not public release numbers.

Versions must increase in SemVer order. Stable versions, including `0.0.1`, use `latest`. Versions ending in `-alpha.N`, `-beta.N`, or `-rc.N` use `next` and are marked as prereleases. Pin exact versions or image digests when deploying.

| Component | Artifact | Release tag |
| --- | --- | --- |
| Server | `ghcr.io/isroilova/otp-router:<version>` for Linux amd64/arm64 | `server-v<version>` |
| Client | Public npm package `@otp-router/client@<version>` | `client-v<version>` |

Server Releases include OpenAPI, an image digest reference, and SHA-256 checksums. Tags and Releases are created after the artifacts are available. Published versions are never reused for changed content.

Versions below `1.0.0` may break compatibility. Release notes must identify supported client/server pairings and upgrade steps for breaking changes. Schema changes follow the [database upgrade procedure](operations.md#database-upgrades). Deployment requirements belong in the [operations guide](operations.md).

## Pending breaking replacement

Server `0.2.0` and client `0.2.0` target each other and replace published `server-v0.1.0` / `client-v0.1.0` and earlier releases. Projects, settings, and backend grants move from deployment configuration to the administration API. Remove the old project catalog and principal `projectIds`; configure administrator credentials, principal identities, and administration ceilings, then provision projects through the new API. Engine calls now carry authenticated principal IDs. There are no aliases or compatibility paths.

This release requires a separate fresh database; follow the [database procedure](operations.md#database-upgrades). Old databases are rejected by baseline identity even at the same migration number. These source changes prepare versions only; merging, publishing artifacts, and deployment remain separate actions.

Optional `integrationReference` support is included in this breaking pair and initial router baseline. Earlier development databases are incompatible as well. Update server, client, and strict authorization/event consumers together: accept the optional field in authorization requests, operation/challenge and verification responses, operation/attempt history, and supported events. Preserve omission when absent and use attempt IDs for authorization reservations. Review [correlation privacy and retention](api.md#integration-correlation); pg-boss migration history is unchanged.

Runtime provider accounts, instances, policies, assignments, shared allowances, and credential versions now live in PostgreSQL. Remove static providers, policy settings, and runtime routing settings from deployment configuration; register adapter definitions and versioned selectors, configure runtime administration permissions, and provision runtime resources and explicit project grants using the updated client. Provider contract version 2 separates account identity, send secrets, callback secrets, execution settings, and templates. Update custom adapters with the [plugin contract](plugins.md) and use the [runtime provisioning guide](runtime-configuration.md).

The initial database baseline is `runtime-model-v3`. Databases from both published releases and earlier development baselines are rejected; there is no migration or backfill. Drain the old deployment and retain its database/keys for its own reconciliation and retention window, then provision a separate new database. Never resubmit uncertain sends while moving traffic.

Runtime commands now constrain actions and payloads to their resource kinds. Account grants require explicit `allInstances: true`. Allowance scopes have no lifecycle commands or lifecycle metadata in responses; update their limits directly. Regenerate strict administration consumers from the matching server/client artifacts. The normalized database stores relationships and immutable revisions once; no development-database conversion is supplied.

## Changelog

[GitHub Releases](https://github.com/IsroilovA/otp-router/releases) is the published changelog, linked from [CHANGELOG.md](../CHANGELOG.md). Each component starts with an initial-release entry. Later entries list merged PRs since that component's previous tag. The interval covers repository changes, so shared or other-component changes may appear in both histories.

Use descriptive PR titles and labels `enhancement`, `bug`, or `documentation`. Add `breaking-change` for incompatible changes and database migrations. Include affected components, supported version pairings, and upgrade steps in the PR description. [Generated notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes) link to PRs; they do not infer migration instructions or copy PR descriptions. The [category configuration](../.github/release.yml) retains unlabelled changes under Other changes.

Changelog entries appear during publication. The workflow does not commit changelog files to branches, and reruns preserve published notes.

## One-time publishing setup

No custom GitHub Actions secrets or variables are required. GitHub supplies `GITHUB_TOKEN`; npm uses OIDC. Runtime and provider credentials belong in deployments.

Enable Actions and allow the pinned actions in [check.yml](../.github/workflows/check.yml). Job permissions are declared there; the repository default can remain read-only. Repository/tag rules must permit the workflow to create component tags.

If an existing GHCR package is not linked to this repository, grant the repository Actions write access. After first publication, make the package public so users can pull anonymously; [new GHCR packages default to private](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

In npm package settings, add this GitHub Actions trusted publisher:

| Setting | Value |
| --- | --- |
| Organization or user | `IsroilovA` |
| Repository | `otp-router` |
| Workflow filename | `check.yml` |
| Environment | Empty |
| Allowed actions | Direct `npm publish` |

Use [npm's setup guide](https://docs.npmjs.com/trusted-publishers/) or [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/). Keep the package repository URL matched to this public repository for provenance. After verifying OIDC publication, require 2FA and disallow traditional publishing tokens in npm settings.

## Release verification

Before merging:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm --filter @otp-router/client pack:check
```

Confirm CI passes on Node 24/26 and image smoke tests pass on Linux amd64/arm64. Confirm npm trusted publishing and GHCR access are configured. Tests use fake or mocked providers; live delivery requires [provider validation](provider-setup.md).

For each published component, verify its Release and artifacts: server assets and anonymous image pulls, or client installation in a clean project. Confirm registry channel tags resolve to the intended versions.

## Interrupted publication

Already-published versions are skipped on later commits. If publication stopped after uploading an artifact, rerun the same commit. The workflow verifies that the existing artifact matches before completing its tag and Release. Drafts recover missing assets; published assets are not overwritten. Restore missing published assets from the original release build before rerunning.

A run is skipped once a newer component tag exists, preventing stale retries from moving registry channels backward. If an existing artifact or tag contains different content, investigate; never overwrite it or move the tag.
