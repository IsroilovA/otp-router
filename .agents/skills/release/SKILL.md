---
name: release
description: Prepare, publish, or verify an OTP Router release. Use for release readiness and interrupted publication, not service deployment.
---

# Release

Follow the [release guide](../../../docs/releases.md); it owns versioning, changelog, verification, and recovery rules.

1. Compare pending changes with published component tags and artifacts. Identify affected components and confirm intended versions.
2. Prepare the version changes and PR using the guide's changelog and release-verification requirements.
3. When merging is authorized, verify required checks on the current PR head, merge, and follow the resulting `main` publication run.
4. Verify each component's Release, artifacts, and registry channel using the guide. A merge or green CI alone does not prove publication.
5. For failures, follow the interrupted-publication procedure; stop on artifact mismatches. Report released versions, links, verification results, and remaining blockers.
