import { Data, Effect, Schema } from "effect";
import { visit } from "jsonc-parser";

export class InvalidJson extends Data.TaggedError("InvalidJson") {}

export const parseJson = (source: string): Effect.Effect<unknown, InvalidJson> =>
  Effect.try({
    try: () => {
      const objects: Set<string>[] = [];
      visit(
        source,
        {
          onObjectBegin: () => {
            objects.push(new Set());
          },
          onObjectEnd: () => {
            objects.pop();
          },
          onObjectProperty: (property) => {
            const keys = objects.at(-1);
            if (keys === undefined || keys.has(property)) throw new InvalidJson();
            keys.add(property);
          },
          onLiteralValue: (value: unknown) => {
            if (typeof value === "number" && !Number.isFinite(value)) throw new InvalidJson();
          },
          onError: () => {
            throw new InvalidJson();
          },
        },
        { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
      );
      // Native parsing preserves own properties such as __proto__ without setters.
      const value: unknown = JSON.parse(source);
      return value;
    },
    catch: () => new InvalidJson(),
  });

export const decodeJson =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (source: string): Effect.Effect<A, InvalidJson> =>
    parseJson(source).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(schema, { errors: "all", onExcessProperty: "error" }),
      ),
      Effect.mapError(() => new InvalidJson()),
    );
