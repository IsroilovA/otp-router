import { execFileSync, spawnSync } from "node:child_process";
import { Schema } from "effect";

const product = Schema.decodeUnknownSync(Schema.Literals(["server", "client"]))(process.argv[2]);
const environment = Schema.decodeUnknownSync(
  Schema.Struct({
    TAG: Schema.NonEmptyString,
    VERSION: Schema.NonEmptyString,
    PRERELEASE: Schema.Literals(["true", "false"]),
  }),
)(process.env);
const prerelease = environment.PRERELEASE === "true";
const assets = product === "server" ? ["openapi.json", "image-digest.txt", "SHA256SUMS"] : [];
const Release = Schema.Struct({
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const gh = (...args: ReadonlyArray<string>): void => {
  execFileSync("gh", args, { stdio: "inherit" });
};
const readRelease = () => {
  const result = spawnSync(
    "gh",
    ["release", "view", environment.TAG, "--json", "isDraft,isPrerelease,assets"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    if (result.stderr.trim() === "release not found") return undefined;
    throw new Error(`Could not inspect GitHub Release: ${result.stderr}`);
  }
  return Schema.decodeUnknownSync(Release)(JSON.parse(result.stdout));
};

const existing = readRelease();
if (existing === undefined) {
  gh(
    "release",
    "create",
    environment.TAG,
    ...assets,
    "--verify-tag",
    "--title",
    `${product === "server" ? "Server" : "Client"} ${environment.VERSION}`,
    "--generate-notes",
    ...(prerelease ? ["--prerelease"] : []),
  );
} else {
  if (existing.isPrerelease !== prerelease) {
    throw new Error("Existing GitHub Release prerelease flag disagrees with version");
  }
  if (existing.isDraft) {
    // Drafts are mutable; restore every required asset before publishing the release.
    if (assets.length > 0) gh("release", "upload", environment.TAG, ...assets, "--clobber");
    gh("release", "edit", environment.TAG, "--draft=false");
  }
}
const published = readRelease();
if (published === undefined || published.isDraft || published.isPrerelease !== prerelease) {
  throw new Error(
    "GitHub Release is not published with the expected prerelease flag; rerun this commit",
  );
}
const missing = assets.filter((name) => !published.assets.some((asset) => asset.name === name));
if (missing.length > 0) {
  throw new Error(
    `Published GitHub Release is missing ${missing.join(", ")}; restore the original assets before rerunning. Published assets will not be overwritten.`,
  );
}
