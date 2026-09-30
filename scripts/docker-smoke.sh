#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
image="${1:-otp-router:smoke}"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/otp-router-smoke.XXXXXX")"
project="otp-router-smoke-$(node -p 'require("node:crypto").randomBytes(6).toString("hex")')"
export OTP_ROUTER_IMAGE="$image"
export OTP_ROUTER_ENV_FILE="$smoke_dir/router.env"
export OTP_ROUTER_POSTGRES_ENV_FILE="$smoke_dir/postgres.env"
export OTP_ROUTER_CONFIG_DIR="$smoke_dir/config"
export OTP_ROUTER_PORT=0

cleanup() {
  docker compose --project-name "$project" -f examples/deployment/compose.yaml down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$smoke_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$OTP_ROUTER_CONFIG_DIR"
cp examples/config/router.config.ts "$OTP_ROUTER_CONFIG_DIR/router.config.ts"
cp examples/admin/provisioning.ts "$OTP_ROUTER_CONFIG_DIR/provisioning.ts"
chmod 755 "$smoke_dir" "$OTP_ROUTER_CONFIG_DIR"
node --input-type=module - "$smoke_dir" <<'NODE'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
const secret = () => randomBytes(32).toString("base64url");
const password = randomBytes(24).toString("hex");
const router = {
  DATABASE_URL: `postgres://otp_router:${password}@postgres:5432/otp_router`,
  OTP_ROUTER_API_KEY: secret(),
  OTP_ROUTER_ADMIN_KEY: secret(),
  OTP_ROUTER_FAKE_CALLBACK_SECRET: secret(),
  OTP_ROUTER_ENCRYPTION_KEY: secret(),
  OTP_ROUTER_VERIFICATION_KEY: secret(),
  OTP_ROUTER_FINGERPRINT_KEY: secret(),
  OTP_ROUTER_RECIPIENT_KEY: secret(),
};
writeFileSync(join(directory, "router.env"), Object.entries(router).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
writeFileSync(join(directory, "postgres.env"), `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
NODE

docker image inspect "$image" >/dev/null
docker compose --project-name "$project" -f examples/deployment/compose.yaml up -d --wait --wait-timeout 180
docker compose --project-name "$project" -f examples/deployment/compose.yaml exec -T router node --input-type=module -e '
import { randomUUID } from "node:crypto";
import { demoCommands } from "/app/apps/server/config/provisioning.ts";

if (process.getuid?.() === 0) throw new Error("router container runs as root");
const provisioned = await fetch("http://127.0.0.1:3000/v1/admin/projects", {
  method: "POST", headers: { authorization: `Bearer ${process.env.OTP_ROUTER_ADMIN_KEY}`, "content-type": "application/json", "idempotency-key": "smoke-project" },
  body: JSON.stringify({ id: "demo", settings: { authorizationRequired: false, sendLimit15m: 100, sendLimit24h: 1000 }, principalIds: ["backend"] }),
});
if (provisioned.status !== 201) throw new Error(`provision status ${provisioned.status}`);
await provisioned.arrayBuffer();
for (const [index, command] of demoCommands(process.env.OTP_ROUTER_FAKE_CALLBACK_SECRET).entries()) {
  const response = await fetch("http://127.0.0.1:3000/v1/admin/runtime/commands", {
    method: "POST", headers: { authorization: `Bearer ${process.env.OTP_ROUTER_ADMIN_KEY}`, "content-type": "application/json", "idempotency-key": `smoke-runtime-${index}` },
    body: JSON.stringify({ command }),
  });
  if (!response.ok) throw new Error(`runtime provision status ${response.status}: ${await response.text()}`);
  await response.arrayBuffer();
}
const base = "http://127.0.0.1:3000/v1/projects/demo/challenges";
const headers = {
  authorization: `Bearer ${process.env.OTP_ROUTER_API_KEY}`,
  "content-type": "application/json",
  "idempotency-key": randomUUID(),
};
const created = await fetch(base, {
  method: "POST",
  headers,
  signal: AbortSignal.timeout(5000),
  body: JSON.stringify({
    recipient: { type: "phone", phoneNumber: "+998901234567" },
    purpose: "login",
    contextId: "docker-smoke",
    policyId: "login",
  }),
});
if (created.status !== 201) throw new Error(`create status ${created.status}: ${await created.text()}`);
const challenge = await created.json();
if (typeof challenge.challengeId !== "string" || challenge.challengeId.length === 0)
  throw new Error("create response has no challengeId");
const read = await fetch(`${base}/${encodeURIComponent(challenge.challengeId)}`, {
  headers: { authorization: `Bearer ${process.env.OTP_ROUTER_API_KEY}` },
  signal: AbortSignal.timeout(5000),
});
if (read.status !== 200) throw new Error(`read status ${read.status}: ${await read.text()}`);
const snapshot = await read.json();
if (snapshot.challengeId !== challenge.challengeId)
  throw new Error("read response does not match the created challenge");
console.log("Docker smoke passed: ready, challenge create, challenge read");
'
