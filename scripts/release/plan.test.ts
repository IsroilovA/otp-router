import { execFileSync } from "node:child_process";
import { mkdtempDisposableSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const plan = join(import.meta.dirname, "plan.ts");

const git = (directory: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

const manifest = (directory: string, product: "server" | "client", version: string): void => {
  const path = product === "server" ? "apps/server/package.json" : "packages/client/package.json";
  writeFileSync(join(directory, path), JSON.stringify({ name: `@otp-router/${product}`, version }));
};

const commit = (directory: string): string => {
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "release fixture");
  return git(directory, "rev-parse", "HEAD");
};

const run = (directory: string, product: "server" | "client", sha: string): string => {
  const output = join(directory, ".git", "release-output");
  writeFileSync(output, "");
  execFileSync(process.execPath, [plan, product], {
    cwd: directory,
    env: {
      ...process.env,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: "IsroilovA/otp-router",
      GITHUB_OUTPUT: output,
    },
  });
  return readFileSync(output, "utf8");
};

test("component versions release independently and stale retries cannot move a channel backward", () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), "otp-release-"));
  const directory = temporary.path;
  mkdirSync(join(directory, "apps/server"), { recursive: true });
  mkdirSync(join(directory, "packages/client"), { recursive: true });
  git(directory, "init", "-qb", "main");
  git(directory, "config", "user.name", "Release Test");
  git(directory, "config", "user.email", "release@example.test");
  manifest(directory, "server", "0.1.0-alpha.1");
  manifest(directory, "client", "0.1.0-alpha.1");
  const first = commit(directory);
  const initialServer = run(directory, "server", first);
  expect(initialServer).toContain("state=publish\n");
  expect(run(directory, "client", first)).toContain("state=publish\n");
  expect(initialServer).toContain("channel=next\nprerelease=true\n");
  expect(initialServer).toContain("previous_tag=\n");

  git(directory, "tag", "server-v0.1.0-alpha.1");
  expect(run(directory, "server", first)).toContain("state=recover\n");
  const independentClient = run(directory, "client", first);
  expect(independentClient).toContain("state=publish\n");
  expect(independentClient).toContain("previous_tag=\n");

  manifest(directory, "server", "0.1.0-alpha.2");
  const second = commit(directory);
  git(directory, "tag", "client-v8.0.0");
  const nextServer = run(directory, "server", second);
  expect(nextServer).toContain("state=publish\n");
  expect(nextServer).toContain("previous_tag=server-v0.1.0-alpha.1\n");
  git(directory, "tag", "server-v0.1.0-alpha.2");
  git(directory, "checkout", "-q", first);
  const staleServer = run(directory, "server", first);
  expect(staleServer).toContain("state=skip\n");
  expect(staleServer).toContain("previous_tag=\n");
  git(directory, "checkout", "-q", second);

  manifest(directory, "server", "0.1.0-alpha.0");
  const downgrade = commit(directory);
  expect(() => run(directory, "server", downgrade)).toThrow(/must be newer/);
});

test("stable version selects latest and rejects mismatched push commit", () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), "otp-release-"));
  const directory = temporary.path;
  mkdirSync(join(directory, "apps/server"), { recursive: true });
  git(directory, "init", "-qb", "main");
  git(directory, "config", "user.name", "Release Test");
  git(directory, "config", "user.email", "release@example.test");
  manifest(directory, "server", "0.1.0");
  const sha = commit(directory);
  git(directory, "tag", "server-v0.0.9");
  git(directory, "tag", "server-v0.0.10");
  const stableServer = run(directory, "server", sha);
  expect(stableServer).toContain("channel=latest\nprerelease=false\n");
  expect(stableServer).toContain("previous_tag=server-v0.0.10\n");
  expect(() => run(directory, "server", "0".repeat(40))).toThrow(/main push commit/);
});
