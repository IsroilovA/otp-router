import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { valid } from "semver";

const Version = Schema.String.check(Schema.makeFilter((value) => valid(value) !== null));

const Pack = Schema.Array(
  Schema.Struct({
    name: Schema.Literal("@otp-router/client"),
    version: Version,
    filename: Schema.String.check(Schema.isPattern(/^otp-router-client-[0-9A-Za-z.-]+\.tgz$/)),
    integrity: Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]+={0,2}$/)),
  }),
);
const path = Schema.decodeUnknownSync(Schema.NonEmptyString)(process.argv[2]);
const packed = Schema.decodeUnknownSync(Pack)(JSON.parse(readFileSync(path, "utf8")));
const manifest = Schema.decodeUnknownSync(Schema.Struct({ version: Version }))(
  JSON.parse(readFileSync("package.json", "utf8")),
);
if (packed.length !== 1 || packed[0]?.version !== manifest.version) {
  throw new Error("Packed client version does not match its manifest");
}
if (packed[0].filename !== `otp-router-client-${manifest.version}.tgz`) {
  throw new Error("Unexpected client tarball filename");
}
