import { readFileSync } from "node:fs";
import { Schema } from "effect";

const Integrity = Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]+={0,2}$/));
const registryPath = Schema.decodeUnknownSync(Schema.NonEmptyString)(process.argv[2]);
const packPath = Schema.decodeUnknownSync(Schema.NonEmptyString)(process.argv[3]);
const registry = Schema.decodeUnknownSync(Integrity)(readFileSync(registryPath, "utf8").trim());
const packed = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ integrity: Integrity })))(
  JSON.parse(readFileSync(packPath, "utf8")),
);
if (packed.length !== 1 || packed[0]?.integrity !== registry) {
  throw new Error("Existing npm version differs from the tarball built at this commit");
}
