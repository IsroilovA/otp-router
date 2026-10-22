# Releases

`dev` is the integration branch. Merge a reviewed version change into `main` to request publication after CI passes. Wait for that run to finish before releasing another version of the same component. Publication does not bump versions or deploy a service.

## Versions and artifacts

Server and client versions are independent. Update the affected [server](../apps/server/package.json) or [client](../packages/client/package.json) manifest; engine changes affecting the server need a server version bump. Workspace and private engine versions are not public release numbers.

Versions must increase in SemVer order. Stable versions, including `0.0.1`, use `latest`. Versions ending in `-alpha.N`, `-beta.N`, or `-rc.N` use `next` and are marked as prereleases. Pin exact versions or image digests when deploying.

| Component | Artifact                                                       | Release tag         |
| --------- | -------------------------------------------------------------- | ------------------- |
| Server    | `ghcr.io/isroilova/otp-router:<version>` for Linux amd64/arm64 | `server-v<version>` |
| Client    | Public npm package `@otp-router/client@<version>`              | `client-v<version>` |

Server Releases include OpenAPI, an image digest reference, and SHA-256 checksums. Tags and Releases are created after the artifacts are available. Published versions are never reused for changed content.

Versions below `1.0.0` may break compatibility. Release notes must identify supported client/server pairings and upgrade steps for breaking changes. Schema changes follow the [database upgrade procedure](operations.md#database-upgrades). Deployment requirements belong in the [operations guide](operations.md).

## Pending 0.3.0

Server `0.3.0` and client `0.3.0` target each other and upgrade published `server-v0.2.0` / `client-v0.2.0`. These source versions prepare publication; merging, artifact publication, and deployment are separate actions.

Update host runtimes to Node.js 26.12.1 or newer and use pnpm 12.15.0. Client packaging and publication use npm 12.2.1. Containers use Node 26 on Debian Trixie; PostgreSQL images remain pinned to 18.6.

Rebuild trusted deployment extensions against the pinned stable Effect `4.0.5` package set. Replace imports from `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/sql`, and `effect/unstable/observability` with the exported `effect/http`, `effect/http-api`, `effect/sql`, and `effect/observability` entrypoints. Some integration APIs remain marked unstable by Effect; the [compiler configuration](../tsconfig.base.json) explicitly allows the integrations this project adopts.

The HTTP contract and router database baseline are unchanged from `0.2.0`; no fresh router database or backfill is required. pg-boss upgrades its own schema to version 46 automatically during startup. Follow the [database upgrade procedure](operations.md#database-upgrades) before restarting the deployment.

## Published 0.2.0 replacement

Published server `0.2.0` and client `0.2.0` replaced `0.1.0` and earlier releases. Upgrading from those older releases still requires a separate fresh database and the [database replacement procedure](operations.md#replacing-010-and-earlier), including retention of the old deployment's data and keys. No migration, import, or backfill is supplied.

For that replacement, update integrations together:
- Remove the deployment project catalog and principal `projectIds`. Configure administrator credentials, backend principal identities, and administration ceilings; provision projects and grants through [project administration](projects.md). Direct engine calls must supply the authenticated principal ID.
- Remove static provider and policy catalogs. Register installed adapters and versioned selectors, configure runtime administration permissions, and provision accounts, credentials, instances, policies, and assignments through [runtime administration](runtime-configuration.md). Custom adapters must implement [provider contract version 2](plugins.md#providers), with separate account identity, send secrets, callback secrets, execution settings, and templates.
- Update runtime command consumers to the [current schemas](../packages/engine/src/runtime/contracts.ts). Commands constrain payloads to resource kinds; account grants require `allInstances: true`, and allowance scopes support limit edits without lifecycle commands or lifecycle metadata.
- Update strict authorization and event consumers for the optional [integration reference](api.md#integration-correlation). Preserve its presence and exact value on retries, and continue using attempt IDs for reservation identity.

Workspace integrations import history services and contracts from `@otp-router/engine/history`. The former history exports from `@otp-router/engine/delivery` and authentication exports from `@otp-router/server/api` are removed without aliases. Update source imports directly. This module reorganization does not change the HTTP contract or database baseline.

## Changelog

[GitHub Releases](https://github.com/IsroilovA/otp-router/releases) is the published changelog, linked from [CHANGELOG.md](../CHANGELOG.md). Each component starts with an initial-release entry. Later entries list merged PRs since that component's previous tag. The interval covers repository changes, so shared or other-component changes may appear in both histories.

Use descriptive PR titles and labels `enhancement`, `bug`, or `documentation`. Add `breaking-change` for incompatible changes and database migrations. Include affected components, supported version pairings, and upgrade steps in the PR description. [Generated notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes) link to PRs; they do not infer migration instructions or copy PR descriptions. The [category configuration](../.github/release.yml) retains unlabelled changes under Other changes.

Changelog entries appear during publication. The workflow does not commit changelog files to branches, and reruns preserve published notes.

## One-time publishing setup

No custom GitHub Actions secrets or variables are required. GitHub supplies `GITHUB_TOKEN`; npm uses OIDC. Runtime and provider credentials belong in deployments.

Enable Actions and allow the pinned actions in [check.yml](../.github/workflows/check.yml). Job permissions are declared there; the repository default can remain read-only. Repository/tag rules must permit the workflow to create component tags.

If an existing GHCR package is not linked to this repository, grant the repository Actions write access. After first publication, make the package public so users can pull anonymously; [new GHCR packages default to private](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

In npm package settings, add this GitHub Actions trusted publisher:

| Setting              | Value                |
| -------------------- | -------------------- |
| Organization or user | `IsroilovA`          |
| Repository           | `otp-router`         |
| Workflow filename    | `check.yml`          |
| Environment          | Empty                |
| Allowed actions      | Direct `npm publish` |

Use [npm's setup guide](https://docs.npmjs.com/trusted-publishers/) or [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/). Keep the package repository URL matched to this public repository for provenance. After verifying OIDC publication, require 2FA and disallow traditional publishing tokens in npm settings.

## Release verification

Before merging:

```sh
npm install --global npm@12.2.1
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm --filter @otp-router/client pack:check
```

Confirm CI passes on Node 26.12.1 and image smoke tests pass on Linux amd64/arm64. Confirm npm trusted publishing and GHCR access are configured. Tests use fake or mocked providers; live delivery requires [provider validation](provider-setup.md).

For each published component, verify its Release and artifacts: server assets and anonymous image pulls, or client installation in a clean project. Confirm registry channel tags resolve to the intended versions.

## Interrupted publication

Already-published versions are skipped on later commits. If publication stopped after uploading an artifact, rerun the same commit. The workflow verifies that the existing artifact matches before completing its tag and Release. Drafts recover missing assets; published assets are not overwritten. Restore missing published assets from the original release build before rerunning.

A run is skipped once a newer component tag exists, preventing stale retries from moving registry channels backward. If an existing artifact or tag contains different content, investigate; never overwrite it or move the tag.
