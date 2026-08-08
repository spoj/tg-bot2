import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBwrapArgs, buildPiWorkerBwrapArgs, runSandbox } from "../src/sandbox.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-agent-test-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await mkdir(workspace); await mkdir(sessions);
  return { root, workspace, sessions };
}

it("constructs the restrictive common profile and direct executable argv", async () => {
  const f = await fixture();
  try {
    const built = await buildBwrapArgs(f, { executable: "/bin/cat", args: ["x;bad"] });
    expect(built.args).toContain("--unshare-user");
    expect(built.args).toContain("--share-net");
    expect(built.args).toContain("--cap-drop");
    expect(built.args).toEqual(expect.arrayContaining([
      "--setenv", "HOME", "/workspace",
      "--setenv", "TMPDIR", "/tmp",
      "--setenv", "PATH", "/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin",
    ]));
    expect(built.args).not.toContain("--unshare-net");
    expect(built.args).not.toContain("/");
    expect(built.args.slice(-3)).toEqual(["--", "/bin/cat", "x;bad"]);
    expect(built.args).toContain("/workspace/sessions_ro");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("binds requested workspace resources read-only and rejects outside paths", async () => {
  const f = await fixture();
  try {
    const skillDirectory = path.join(f.workspace, ".pi", "skills");
    await mkdir(skillDirectory, { recursive: true });
    const built = await buildBwrapArgs({ ...f, readOnlyPaths: [skillDirectory] }, { executable: "/bin/cat", args: [] });
    expect(built.args).toEqual(expect.arrayContaining(["--ro-bind", skillDirectory, "/workspace/.pi/skills"]));
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await expect(buildBwrapArgs({ ...f, readOnlyPaths: [outside] }, { executable: "/bin/cat", args: [] }))
      .rejects.toThrow("under the workspace");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("rejects a symlinked appRoot node_modules tree", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const dependencyTarget = path.join(f.root, "dependencies");
  try {
    await mkdir(appRoot);
    await mkdir(dependencyTarget);
    await symlink(dependencyTarget, path.join(appRoot, "node_modules"), "dir");
    await expect(buildPiWorkerBwrapArgs({ workspace: f.workspace, appRoot }))
      .rejects.toThrow("node_modules must be a real directory");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("loads only explicit regular-file extensions from node_modules", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cliPath = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const extensionPath = path.join(appRoot, "node_modules", "trusted-extension", "index.ts");
  try {
    await mkdir(path.dirname(cliPath), { recursive: true });
    await mkdir(path.dirname(extensionPath), { recursive: true });
    await writeFile(cliPath, "#!/usr/bin/env node\n", { mode: 0o700 });
    await writeFile(extensionPath, "export default () => {};\n", { mode: 0o600 });
    await writeFile(path.join(f.root, "outside.ts"), "export default () => {};\n", { mode: 0o600 });
    const built = await buildPiWorkerBwrapArgs({ workspace: f.workspace, appRoot, extensions: [extensionPath] });
    expect(built.args).toEqual(expect.arrayContaining(["--extension", "/app/node_modules/trusted-extension/index.ts"]));
    await expect(buildPiWorkerBwrapArgs({
      workspace: f.workspace,
      appRoot,
      extensions: [path.join(f.root, "outside.ts")],
    })).rejects.toThrow("under");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const integration = process.env.RUN_BWRAP_TESTS === "1" ? describe : describe.skip;
integration("Bubblewrap integration", () => {
  it("persists workspace, reads sessions, blocks writes, hides secrets, truncates, and times out", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.sessions, "history.jsonl"), "needle\n");
      const skillDirectory = path.join(f.workspace, ".pi", "skills");
      await mkdir(skillDirectory, { recursive: true });
      const skillFile = path.join(skillDirectory, "SKILL.md");
      await writeFile(skillFile, "original\n");
      const protectedRun = await runSandbox(
        { ...f, readOnlyPaths: [skillDirectory] },
        { executable: "/bin/bash", args: ["-lc", "echo changed > .pi/skills/SKILL.md || true; cat .pi/skills/SKILL.md"] },
      );
      expect(protectedRun.stdout).toBe("original\n");
      expect(await readFile(skillFile, "utf8")).toBe("original\n");
      const first = await runSandbox(f, { executable: "/bin/bash", args: ["-lc", "echo persistent > file"] });
      expect(first.exitCode).toBe(0);
      const second = await runSandbox(f, { executable: "/bin/bash", args: ["-lc", "cat file; cat sessions_ro/history.jsonl"] });
      expect(second.stdout).toContain("persistent"); expect(second.stdout).toContain("needle");
      expect(await readFile(path.join(f.workspace, "file"), "utf8")).toBe("persistent\n");
      const blocked = await runSandbox(f, { executable: "/bin/bash", args: ["-lc", "touch sessions_ro/x || true; touch /usr/x || true; test ! -e sessions_ro/x && test ! -e /usr/x"] });
      expect(blocked.exitCode).toBe(0);
      await expect(access(path.join(f.sessions, "x"))).rejects.toThrow();
      process.env.SUPER_SECRET_CANARY = "must-not-leak";
      const env = await runSandbox(f, { executable: "/usr/bin/env", args: [] });
      expect(env.stdout).not.toContain("SUPER_SECRET_CANARY");
      const truncated = await runSandbox(f, { executable: "/bin/bash", args: ["-lc", "printf '%0200d' 0"] }, { maxOutputBytes: 20 });
      expect(truncated.truncated).toBe(true); expect(Buffer.byteLength(truncated.stdout)).toBe(20);
      expect(truncated.stdoutBuffer).toEqual(Buffer.from(truncated.stdout));
      const perRequestLimit = await runSandbox(
        f,
        { executable: "/bin/bash", args: ["-lc", "printf '%040d' 0"], maxOutputBytes: 30 },
        { maxOutputBytes: 20 },
      );
      expect(perRequestLimit.stdoutBuffer).toHaveLength(30);
      expect(perRequestLimit.truncated).toBe(true);
      const binary = await runSandbox(f, {
        executable: "/bin/bash",
        args: ["-c", "printf '\\211PNG\\r\\n\\032\\n\\377'"],
      });
      expect(binary.stdoutBuffer).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]));
      const timeout = await runSandbox(f, { executable: "/bin/bash", args: ["-lc", "sleep 30"], timeoutMs: 30 });
      expect(timeout.timedOut).toBe(true);
    } finally { delete process.env.SUPER_SECRET_CANARY; await rm(f.root, { recursive: true, force: true }); }
  }, 15_000);
});
