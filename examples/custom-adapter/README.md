# Custom adapter fixture

This fixture compiles a small text sink and selector against the documented package exports. It does not send a message. The provider returns deterministic acceptance metadata so the fixture can exercise registration and startup validation without provider credentials.

The dependency points at a local release artifact by design. From a checked-out router release, create the artifact, replace the placeholder path if the artifact name differs, then install and compile:

```sh
pnpm build
mkdir -p artifacts
pnpm pack --pack-destination artifacts
cd examples/custom-adapter
pnpm install --no-frozen-lockfile
pnpm exec tsc -p tsconfig.fixture.json
node dist/smoke.js
```

The fixture imports provider contracts from `otp-router/providers` and configuration selector types from `otp-router/config`. It must continue to compile without private source imports. To build the example image, stage the packed artifact under `examples/custom-adapter/artifacts/otp-router-0.1.0.tgz`, then run `docker build -t otp-router-custom-adapter:local examples/custom-adapter`. The image copies that artifact, compiles the fixture, and runs `dist/smoke.js`, which executes the selector and deterministic provider send. A deployment configuration registers `TextProvider.make(...)` and `textSelector`.
