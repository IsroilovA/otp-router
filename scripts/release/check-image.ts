import { readFileSync } from "node:fs";
import { Schema } from "effect";

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Index = Schema.Struct({
  annotations: Schema.Record(Schema.String, Schema.String),
  manifests: Schema.Array(
    Schema.Struct({
      platform: Schema.Struct({ os: Schema.String, architecture: Schema.String }),
    }),
  ),
});

const path = Schema.decodeUnknownSync(Schema.NonEmptyString)(process.argv[2]);
const expected = Schema.decodeUnknownSync(Sha)(process.env["GITHUB_SHA"]);
const index = Schema.decodeUnknownSync(Index)(JSON.parse(readFileSync(path, "utf8")));
if (index.annotations["org.opencontainers.image.revision"] !== expected) {
  throw new Error("Exact image revision does not match the release commit");
}
for (const architecture of ["amd64", "arm64"]) {
  if (
    !index.manifests.some(
      ({ platform }) => platform.os === "linux" && platform.architecture === architecture,
    )
  ) {
    throw new Error(`Exact image lacks linux/${architecture}`);
  }
}
