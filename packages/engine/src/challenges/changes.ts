import { Context, Effect } from "effect";

// A fresh set belongs to each outer challenge transaction. Nested callback merges
// share it, so a commit publishes only the resulting snapshot for each challenge.
export const Changes = Context.Reference<Set<string> | undefined>("otp-router/Changes", {
  defaultValue: () => undefined,
});
export const changed = (id: string) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    if (changes === undefined)
      return yield* Effect.die(new Error("Challenge mutation outside its transaction"));
    changes.add(id);
  });
