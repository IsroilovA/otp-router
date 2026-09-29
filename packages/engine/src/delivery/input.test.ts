import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { IntegrationReference } from "./input.js";

const decode = Schema.decodeUnknownSync(IntegrationReference);

describe("integration reference validation", () => {
  it("preserves exact valid values at both length boundaries", () => {
    for (const integrationReference of ["A", "Flow.AbC_09:attempt-2", "Z".repeat(128)]) {
      expect(decode(integrationReference)).toBe(integrationReference);
    }
  });

  it("rejects empty, null, non-ASCII, forbidden characters and out-of-bounds values", () => {
    for (const integrationReference of [
      "",
      null,
      123,
      false,
      "a".repeat(129),
      " padded",
      "padded ",
      "contains space",
      "line\n",
      "line\r\n",
      "tab\t",
      "slash/",
      "mail@example",
      "sécret",
      "Ａ",
      "zero\u0000",
      {},
    ]) {
      expect(() => decode(integrationReference)).toThrow(/Expected/u);
    }
  });
});
