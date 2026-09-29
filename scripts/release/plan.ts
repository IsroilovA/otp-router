import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { Schema } from "effect";
import { compare, prerelease, valid } from "semver";

const Version = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/),
  Schema.makeFilter((value) => valid(value) !== null),
);

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Product = Schema.Literals(["server", "client"]);
const Environment = Schema.Struct({
  GITHUB_REF: Schema.Literal("refs/heads/main"),
  GITHUB_SHA: Sha,
  GITHUB_REPOSITORY: Schema.Literal("IsroilovA/otp-router"),
  GITHUB_OUTPUT: Schema.NonEmptyString,
});
const Manifest = Schema.Struct({ name: Schema.String, version: Version });

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

const product = Schema.decodeUnknownSync(Product)(process.argv[2]);
const environment = Schema.decodeUnknownSync(Environment)(process.env);
const manifestPath =
  product === "server" ? "apps/server/package.json" : "packages/client/package.json";
const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(manifestPath, "utf8")));
if (manifest.name !== `@otp-router/${product}`)
  throw new Error(`Unexpected name in ${manifestPath}`);
if (git("rev-parse", "HEAD") !== environment.GITHUB_SHA) {
  throw new Error("Checkout does not match the main push commit");
}

const tag = `${product}-v${manifest.version}`;
const tags = git("tag", "--list", `${product}-v*`).split("\n").filter(Boolean);
const existing = tags.includes(tag);
const current = manifest.version;
const otherVersions = tags
  .filter((previousTag) => previousTag !== tag)
  .map((previousTag) => ({
    tag: previousTag,
    version: Schema.decodeUnknownSync(Version)(previousTag.slice(`${product}-v`.length)),
  }));
let state: "skip" | "recover" | "publish";
if (existing) {
  const taggedCommit = Schema.decodeUnknownSync(Sha)(git("rev-parse", `${tag}^{commit}`));
  const newerExists = otherVersions.some(({ version }) => compare(version, current) > 0);
  state = taggedCommit === environment.GITHUB_SHA && !newerExists ? "recover" : "skip";
} else {
  for (const previous of otherVersions) {
    if (compare(current, previous.version) <= 0) {
      throw new Error(`${tag} must be newer than existing ${previous.tag}`);
    }
  }
  state = "publish";
}

const channel = prerelease(manifest.version) === null ? "latest" : "next";
const previous = otherVersions
  .filter(({ version }) => compare(version, current) < 0)
  .sort((left, right) => compare(right.version, left.version))[0];
appendFileSync(
  environment.GITHUB_OUTPUT,
  `state=${state}\nversion=${manifest.version}\ntag=${tag}\nchannel=${channel}\nprerelease=${channel === "next"}\nprevious_tag=${previous?.tag ?? ""}\n`,
);
process.stdout.write(`${product}: ${tag} (${state}, ${channel})\n`);
