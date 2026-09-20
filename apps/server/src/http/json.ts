import { Data, Effect, Schema } from "effect";

export class InvalidJson extends Data.TaggedError("InvalidJson") {}

interface Cursor {
  readonly source: string;
  offset: number;
}

const whitespace = new Set([" ", "\t", "\n", "\r"]);

const skipWhitespace = (cursor: Cursor): void => {
  while (whitespace.has(cursor.source[cursor.offset] ?? "")) cursor.offset += 1;
};

const fail = (): never => {
  throw new InvalidJson();
};

const decodeString = (source: string): string => {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "string" ? value : fail();
  } catch {
    return fail();
  }
};

const consumeEscape = (cursor: Cursor): void => {
  cursor.offset += 1;
  const escape = cursor.source[cursor.offset];
  if (escape === "u") {
    const code = cursor.source.slice(cursor.offset + 1, cursor.offset + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(code)) return fail();
    cursor.offset += 5;
    return;
  }
  if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return fail();
  cursor.offset += 1;
};

const parseString = (cursor: Cursor): string => {
  if (cursor.source[cursor.offset] !== '"') return fail();
  const start = cursor.offset;
  cursor.offset += 1;
  while (cursor.offset < cursor.source.length) {
    const character = cursor.source[cursor.offset];
    if (character === '"') {
      cursor.offset += 1;
      return decodeString(cursor.source.slice(start, cursor.offset));
    }
    if (character === "\\") consumeEscape(cursor);
    else {
      if (character === undefined || character.charCodeAt(0) < 0x20) return fail();
      cursor.offset += 1;
    }
  }
  return fail();
};

const parseNumber = (cursor: Cursor): number => {
  const rest = cursor.source.slice(cursor.offset);
  const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
  if (match === null) return fail();
  cursor.offset += match[0].length;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return fail();
  return value;
};

const parseLiteral = (cursor: Cursor, literal: "true" | "false" | "null"): boolean | null => {
  if (!cursor.source.startsWith(literal, cursor.offset)) return fail();
  cursor.offset += literal.length;
  if (literal === "true") return true;
  if (literal === "false") return false;
  return null;
};

const parseArray = (cursor: Cursor): ReadonlyArray<unknown> => {
  cursor.offset += 1;
  skipWhitespace(cursor);
  const values: Array<unknown> = [];
  if (cursor.source[cursor.offset] === "]") {
    cursor.offset += 1;
    return values;
  }
  for (;;) {
    values.push(parseValue(cursor));
    skipWhitespace(cursor);
    const delimiter = cursor.source[cursor.offset];
    cursor.offset += 1;
    if (delimiter === "]") return values;
    if (delimiter !== ",") return fail();
    skipWhitespace(cursor);
  }
};

const parseObject = (cursor: Cursor): Readonly<Record<string, unknown>> => {
  cursor.offset += 1;
  skipWhitespace(cursor);
  const value: Record<string, unknown> = {};
  const keys = new Set<string>();
  if (cursor.source[cursor.offset] === "}") {
    cursor.offset += 1;
    return value;
  }
  for (;;) {
    const key = parseString(cursor);
    if (keys.has(key)) return fail();
    keys.add(key);
    skipWhitespace(cursor);
    if (cursor.source[cursor.offset] !== ":") return fail();
    cursor.offset += 1;
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      value: parseValue(cursor),
      writable: true,
    });
    skipWhitespace(cursor);
    const delimiter = cursor.source[cursor.offset];
    cursor.offset += 1;
    if (delimiter === "}") return value;
    if (delimiter !== ",") return fail();
    skipWhitespace(cursor);
  }
};

const parseValue = (cursor: Cursor): unknown => {
  skipWhitespace(cursor);
  const character = cursor.source[cursor.offset];
  if (character === '"') return parseString(cursor);
  if (character === "{") return parseObject(cursor);
  if (character === "[") return parseArray(cursor);
  if (character === "t") return parseLiteral(cursor, "true");
  if (character === "f") return parseLiteral(cursor, "false");
  if (character === "n") return parseLiteral(cursor, "null");
  return parseNumber(cursor);
};

export const parseJson = (source: string): Effect.Effect<unknown, InvalidJson> =>
  Effect.try({
    try: () => {
      const cursor: Cursor = { source, offset: 0 };
      const value = parseValue(cursor);
      skipWhitespace(cursor);
      if (cursor.offset !== source.length) return fail();
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
