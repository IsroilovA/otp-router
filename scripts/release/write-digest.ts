import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { valid } from "semver";

const path = Schema.decodeUnknownSync(Schema.NonEmptyString)(process.argv[2]);
const digest = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
)(readFileSync(path, "utf8").trim());
const version = Schema.decodeUnknownSync(
  Schema.String.check(Schema.makeFilter((value) => valid(value) !== null)),
)(process.env["VERSION"]);
process.stdout.write(`ghcr.io/isroilova/otp-router:${version}@${digest}\n`);
