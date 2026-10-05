import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { rolldown } from "rolldown";
import { dts } from "rolldown-plugin-dts";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
execFileSync(
  "pnpm",
  ["--workspace-root", "exec", "tsc", "--project", "packages/client/tsconfig.build.json"],
  { stdio: "inherit" },
);
const external = /^effect(?:\/|$)/;
{
  await using javascript = await rolldown({
    input: "src/index.ts",
    platform: "node",
    transform: { target: "node26" },
    external,
  });
  await javascript.write({
    file: "dist/index.js",
    format: "es",
    sourcemap: true,
    sourcemapExcludeSources: true,
  });
}
{
  await using declarations = await rolldown({
    input: "dist/types/index.d.ts",
    external,
    plugins: [dts({ dtsInput: true, generator: "oxc", tsconfig: "tsconfig.build.json" })],
  });
  await declarations.write({ file: "dist/index.d.ts", format: "es" });
}
await rm(new URL("../dist/types", import.meta.url), { recursive: true, force: true });
