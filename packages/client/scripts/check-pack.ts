import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

await using directory = await mkdtempDisposable(join(tmpdir(), "otp-router-client-"));
const temporary = directory.path;
const Pack = Schema.Struct({
  "@otp-router/client": Schema.Struct({
    filename: Schema.String,
    files: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
});
const output = execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
  encoding: "utf8",
});
const packed = Schema.decodeUnknownSync(Pack)(JSON.parse(output))["@otp-router/client"];
execFileSync(
  "npm",
  ["publish", "--dry-run", "--access", "public", "--tag", "next", join(temporary, packed.filename)],
  { stdio: "inherit" },
);
assert.ok(packed.files.some((file) => file.path === "LICENSE"));
assert.ok(packed.files.some((file) => file.path === "README.md"));
assert.ok(
  packed.files.every((file) => /^(?:dist\/|LICENSE$|README\.md$|package\.json$)/u.test(file.path)),
  "Only publishable artifacts may be packed",
);
await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
execFileSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temporary, packed.filename),
    "typescript@7.0.2",
    "@types/node@26.6.3",
  ],
  { cwd: temporary, stdio: "inherit" },
);
const dependencies = await readFile(join(temporary, "package-lock.json"), "utf8");
for (const forbidden of ["@otp-router/engine", "@otp-router/server", "pg-boss", "@effect/sql-pg"]) {
  assert.ok(
    !dependencies.includes(`node_modules/${forbidden}`),
    `Published runtime unexpectedly installs ${forbidden}`,
  );
}
await writeFile(
  join(temporary, "consumer.ts"),
  `
import { createAdminClient, type ProjectDecodeDto, createClient, OtpRouterApiError, type CreateChallengeTransferDto, type ChallengeDecodeDto, type IncorrectCodeErrorDto } from "@otp-router/client";
const client = createClient({ baseUrl: "https://router.example", projectId: "demo", bearerToken: "secret" });
const input: CreateChallengeTransferDto = { recipient: { type: "phone", phoneNumber: "+998901234567" }, purpose: "login", contextId: "session", policyId: "login" };
const administrator = createAdminClient({ baseUrl: "https://router.example", bearerToken: "admin-secret" });
export async function verifyAdminTypes(): Promise<ProjectDecodeDto> {
const current = await administrator.getProject("demo");
if (current.etag === null) throw new Error("Missing ETag");
return (await administrator.suspendProject("demo", { etag: current.etag, idempotencyKey: "retained-admin-key" })).data;
}
export async function verifyTypes(): Promise<ChallengeDecodeDto> {
try { return (await client.createChallenge(input, { idempotencyKey: "retained-key" })).data; }
catch (error: unknown) {
  if (error instanceof OtpRouterApiError && error.error.code === "incorrect_code") {
    const detail: IncorrectCodeErrorDto = error.error;
    if (detail.reason === "locked") throw new Error("No further guesses");
  }
  throw error;
}
}
`,
);
execFileSync(
  process.execPath,
  [
    join(temporary, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "false",
    "--types",
    "node",
    "--target",
    "ES2024",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "consumer.ts",
  ],
  { cwd: temporary, stdio: "inherit" },
);
await writeFile(
  join(temporary, "consumer.mjs"),
  `
import assert from "node:assert/strict";
import { createClient, OtpRouterApiError } from "@otp-router/client";
let sends = 0;
const client = createClient({ baseUrl: "https://router.example", projectId: "demo", bearerToken: "secret", fetch: async (url, init) => {
sends += 1;
assert.equal(String(url), "https://router.example/v1/projects/demo/challenges/retained-id");
assert.equal(new Headers(init.headers).get("authorization"), "Bearer secret");
return Response.json({ error: { code: "unauthorized", message: "Unauthorized", requestId: "trace" } }, { status: 401 });
} });
await assert.rejects(client.getChallenge("retained-id"), (error) => error instanceof OtpRouterApiError && error.error.code === "unauthorized" && error.status === 401);
assert.equal(sends, 1);
`,
);
execFileSync(process.execPath, ["consumer.mjs"], { cwd: temporary, stdio: "inherit" });
process.stdout.write(
  "Packed client passed isolated installation, TypeScript DTO and runtime checks.\n",
);
