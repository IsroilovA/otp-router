import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
// The local TypeScript 6 alias supplies the bundler compiler API; compilation stays on root TypeScript 7.
execFileSync(
  "pnpm",
  ["--workspace-root", "exec", "tsc", "--project", "packages/client/tsconfig.build.json"],
  { stdio: "inherit" },
);
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["effect", "effect/*"],
  sourcemap: true,
  sourcesContent: false,
});
const declarations = await rollup({
  input: "dist/types/index.d.ts",
  external: (id) => id === "effect" || id.startsWith("effect/"),
  plugins: [dts({ respectExternal: true, tsconfig: "tsconfig.build.json" })],
});
await declarations.write({ file: "dist/index.d.ts", format: "es" });
await declarations.close();
await rm(new URL("../dist/types", import.meta.url), { recursive: true, force: true });
