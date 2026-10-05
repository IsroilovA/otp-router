import { spawnSync } from "node:child_process";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("npm 12 pack metadata gates publication on the manifest version and registry integrity", () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), "otp-pack-"));
  const directory = temporary.path;
  const packPath = join(directory, "pack.json");
  const registryPath = join(directory, "registry-integrity");
  const packed = {
    name: "@otp-router/client",
    version: "0.2.0",
    filename: "otp-router-client-0.2.0.tgz",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  };
  const run = (script: string, ...args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], {
      cwd: directory,
      encoding: "utf8",
    });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.2.0" }));
  writeFileSync(packPath, JSON.stringify({ "@otp-router/client": packed }));
  writeFileSync(registryPath, `${packed.integrity}\n`);
  expect(run("read-pack.ts", packPath).status).toBe(0);
  expect(run("check-integrity.ts", registryPath, packPath).status).toBe(0);

  writeFileSync(registryPath, `sha512-${Buffer.alloc(64, 2).toString("base64")}\n`);
  expect(run("check-integrity.ts", registryPath, packPath).stderr).toContain(
    "Existing npm version differs",
  );
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.3.0" }));
  expect(run("read-pack.ts", packPath).stderr).toContain(
    "Packed client version does not match its manifest",
  );
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.2.0" }));
  writeFileSync(
    packPath,
    JSON.stringify({
      "@otp-router/client": { ...packed, filename: "otp-router-client-0.3.0.tgz" },
    }),
  );
  expect(run("read-pack.ts", packPath).stderr).toContain("Unexpected client tarball filename");
});
