import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { parseJson } from "./json.js";

it.effect(
  "rejects ambiguous keys and nonstandard JSON without relaxing native object semantics",
  () =>
    Effect.gen(function* () {
      for (const input of [
        '{"a":1,"a":2}',
        '{"nested":[{"a":1,"\\u0061":2}]}',
        '{"a":1,}',
        "[1,]",
        '{/*comment*/"a":1}',
        '{"a":1} trailing',
        '{"a":1e400}',
        "",
      ]) {
        expect(yield* parseJson(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "InvalidJson" },
        });
      }
      const parsed = yield* parseJson('{"items":[{"a":1},{"a":2}],"__proto__":{"safe":true}}');
      expect(parsed).toEqual(JSON.parse('{"items":[{"a":1},{"a":2}],"__proto__":{"safe":true}}'));
      expect(Object.hasOwn(parsed ?? {}, "__proto__")).toBe(true);
    }),
);
