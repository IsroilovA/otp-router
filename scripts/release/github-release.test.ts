import { beforeEach, expect, test, vi } from "vitest";

const cli = vi.hoisted(() => ({
  run: vi.fn<(command: string, args: ReadonlyArray<string>) => void>(),
  view: vi.fn<
    () => { readonly status: number; readonly stdout: string; readonly stderr: string }
  >(),
}));
vi.mock("node:child_process", () => ({ execFileSync: cli.run, spawnSync: cli.view }));

const required = ["openapi.json", "image-digest.txt", "SHA256SUMS"];
const release = (isDraft: boolean, names: ReadonlyArray<string>, isPrerelease = true) => ({
  status: 0,
  stdout: JSON.stringify({ isDraft, isPrerelease, assets: names.map((name) => ({ name })) }),
  stderr: "",
});
const run = async (product = "server") => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "github-release.ts", product]);
  await import("./github-release.js");
};

beforeEach(() => {
  vi.resetModules();
  cli.run.mockReset();
  cli.view.mockReset();
  vi.stubEnv("TAG", "server-v0.1.0-alpha.1");
  vi.stubEnv("VERSION", "0.1.0-alpha.1");
  vi.stubEnv("PRERELEASE", "true");
  vi.stubEnv("PREVIOUS_TAG", "");
});

test("restores incomplete draft assets before publishing and tolerates a completed rerun", async () => {
  cli.view
    .mockReturnValueOnce(release(true, ["openapi.json"]))
    .mockReturnValue(release(false, required));
  await run();
  expect(cli.run.mock.calls).toEqual([
    [
      "gh",
      ["release", "upload", "server-v0.1.0-alpha.1", ...required, "--clobber"],
      { stdio: "inherit" },
    ],
    ["gh", ["release", "edit", "server-v0.1.0-alpha.1", "--draft=false"], { stdio: "inherit" }],
  ]);
  vi.resetModules();
  cli.run.mockClear();
  await run();
  expect(cli.run).not.toHaveBeenCalled();
});

test("does not publish a draft when uploading its assets fails", async () => {
  cli.view.mockReturnValue(release(true, []));
  cli.run.mockImplementation(() => {
    throw new Error("Upload interrupted");
  });
  await expect(run()).rejects.toThrow("Upload interrupted");
  expect(cli.run.mock.calls.some(([, args]) => args.includes("edit"))).toBe(false);
});

test("rejects missing published assets and mismatched release flags without overwriting", async () => {
  cli.view.mockReturnValue(release(false, ["openapi.json"]));
  await expect(run()).rejects.toThrow("missing image-digest.txt, SHA256SUMS");
  vi.resetModules();
  cli.view.mockReturnValue(release(true, required, false));
  await expect(run()).rejects.toThrow("prerelease flag disagrees");
  expect(cli.run).not.toHaveBeenCalled();
});

test("creates an absent client release but does not interpret lookup failures as absence", async () => {
  vi.stubEnv("TAG", "client-v0.1.0-alpha.1");
  cli.view
    .mockReturnValueOnce({ status: 1, stdout: "", stderr: "release not found\n" })
    .mockReturnValue(release(false, []));
  await run("client");
  expect(cli.run).toHaveBeenCalledWith(
    "gh",
    [
      "release",
      "create",
      "client-v0.1.0-alpha.1",
      "--verify-tag",
      "--title",
      "Client 0.1.0-alpha.1",
      "--notes",
      "Initial client release of OTP Router.\n\n[Documentation and source](https://github.com/IsroilovA/otp-router/tree/client-v0.1.0-alpha.1) · [Full history](https://github.com/IsroilovA/otp-router/commits/client-v0.1.0-alpha.1/)",
      "--prerelease",
    ],
    { stdio: "inherit" },
  );
  vi.resetModules();
  cli.run.mockClear();
  cli.view.mockReturnValue({ status: 1, stdout: "", stderr: "connection refused" });
  await expect(run("client")).rejects.toThrow("Could not inspect GitHub Release");
  expect(cli.run).not.toHaveBeenCalled();
});

test("generates subsequent notes from the supplied component tag", async () => {
  vi.stubEnv("PREVIOUS_TAG", "server-v0.1.0-alpha.0");
  cli.view
    .mockReturnValueOnce({ status: 1, stdout: "", stderr: "release not found\n" })
    .mockReturnValue(release(false, required));
  await run();
  expect(cli.run).toHaveBeenCalledWith(
    "gh",
    [
      "release",
      "create",
      "server-v0.1.0-alpha.1",
      ...required,
      "--verify-tag",
      "--title",
      "Server 0.1.0-alpha.1",
      "--generate-notes",
      "--notes-start-tag",
      "server-v0.1.0-alpha.0",
      "--prerelease",
    ],
    { stdio: "inherit" },
  );
});
