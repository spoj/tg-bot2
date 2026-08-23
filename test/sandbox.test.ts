import { spawnSync, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBwrapArgs, buildPiRunBwrapArgs, checkSandboxEnvironment, runSandbox, spawnProcess, terminateProcessGroup } from "../src/sandbox.js";
import { openPinnedDirectory } from "../src/util.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-agent-test-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await mkdir(workspace); await mkdir(sessions);
  return { root, workspace, sessions };
}

function bwrapAvailable(): boolean {
  try {
    return spawnSync("bwrap", ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

// Integration tests must poll real OS state — a host file appearing and the
// bwrap process group being reaped — which fake timers cannot drive.
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function hostPids(pattern: string): string[] {
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`pgrep failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean);
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
it("rejects non-directory and symlinked sessions sources", async () => {
  const f = await fixture();
  const file = path.join(f.root, "sessions-file");
  const target = path.join(f.root, "sessions-target");
  const linked = path.join(f.root, "sessions-link");
  try {
    await writeFile(file, "not a directory");
    await mkdir(target);
    await symlink(target, linked, "dir");
    await expect(buildBwrapArgs({ ...f, sessions: file }, { executable: "/bin/cat", args: [] }))
      .rejects.toThrow("sessions must be a real directory");
    await expect(buildBwrapArgs({ ...f, sessions: linked }, { executable: "/bin/cat", args: [] }))
      .rejects.toThrow("sessions must be a real directory");
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
    await expect(buildPiRunBwrapArgs({ workspace: f.workspace, appRoot }))
      .rejects.toThrow("node_modules must be a real directory");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("rejects timeout values outside Node's timer-safe range before spawning", async () => {
  const invalidTimeouts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 2_147_483_648];
  for (const timeoutMs of invalidTimeouts) {
    await expect(runSandbox(
      { workspace: "/missing-workspace", sessions: "/missing-sessions" },
      { executable: "/bin/true", args: [], timeoutMs },
    )).rejects.toThrow("timeoutMs must be a positive safe integer");
  }
});

it("returns canonical data and validated Bubblewrap path after probing with alternate executables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-agent-data-test-"));
  const target = path.join(root, "data");
  const linked = path.join(root, "data-link");
  const bin = path.join(root, "bin");
  const node = path.join(bin, "node");
  const bwrap = path.join(bin, "bwrap");
  const log = path.join(root, "bwrap-args");
  const previousPath = process.env.PATH;
  try {
    await mkdir(target);
    await symlink(target, linked, "dir");
    await mkdir(bin);
    await writeFile(node, "#!/bin/sh\nprintf node\n", { mode: 0o755 });
    await writeFile(bwrap, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\ncat >/dev/null\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    const appRoot = path.join(root, "app");
    const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    const workerArgs = await buildPiRunBwrapArgs({ workspace: target, appRoot, model: "anthropic/claude", thinkingLevel: "high" });
    expect(workerArgs.args).toContain(await realpath(node));
    expect(workerArgs.args).not.toContain("/usr/bin/node");
    expect(workerArgs.args.slice(workerArgs.args.indexOf("--") + 1)).toEqual([
      await realpath(node),
      "/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      "--mode", "rpc", "--session-dir", "/workspace/.pi/sessions", "--approve",
      "--model", "anthropic/claude", "--thinking", "high",
    ]);
    const result = await checkSandboxEnvironment(linked, { bwrapPath: bwrap });
    expect(result).toEqual({ dataDir: target, bwrapPath: await realpath(bwrap) });
    const args = await readFile(log, "utf8");
    expect(args).toContain(await realpath(node));
    expect(args).not.toContain("/usr/bin/node");
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
it("binds the node binary's parent directory when node is outside the standard mount prefixes", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const bin = path.join(f.root, "bin");
  const fakeNode = path.join(bin, "node");
  const previousPath = process.env.PATH;
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    await mkdir(bin);
    await writeFile(fakeNode, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = bin;
    const workerArgs = await buildPiRunBwrapArgs({ workspace: f.workspace, appRoot });
    expect(workerArgs.args).toContain(await realpath(fakeNode));
    const nodeDir = path.dirname(await realpath(fakeNode));
    expect(workerArgs.args).toEqual(expect.arrayContaining(["--ro-bind", nodeDir, nodeDir]));
  } finally {
    process.env.PATH = previousPath;
    await rm(f.root, { recursive: true, force: true });
  }
});
it.skipIf(process.execPath !== "/usr/bin/node")("does not add a duplicate node bind when node is under /usr", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const previousPath = process.env.PATH;
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    process.env.PATH = "/usr/bin";
    const workerArgs = await buildPiRunBwrapArgs({ workspace: f.workspace, appRoot });
    expect(workerArgs.args).toContain(process.execPath);
    const nodeDir = path.dirname(process.execPath);
    const bindPairs: Array<[string, string]> = [];
    for (let i = 0; i < workerArgs.args.length - 2; i++) {
      const source = workerArgs.args[i + 1];
      const destination = workerArgs.args[i + 2];
      if (workerArgs.args[i] === "--ro-bind" && source !== undefined && destination !== undefined) {
        bindPairs.push([source, destination]);
      }
    }
    expect(bindPairs).toContainEqual(["/usr", "/usr"]);
    expect(bindPairs).not.toContainEqual([nodeDir, nodeDir]);
  } finally {
    process.env.PATH = previousPath;
    await rm(f.root, { recursive: true, force: true });
  }
});
it("binds appendSystemPrompt read-only to /app/append-system-prompt.md", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const hostPrompt = path.join(f.root, "system-prompt.md");
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(hostPrompt, "prompt text", { mode: 0o600 });
    const workerArgs = await buildPiRunBwrapArgs({
      workspace: f.workspace,
      appRoot,
      appendSystemPrompt: hostPrompt,
    });
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--dir", "/app",
      "--ro-bind", hostPrompt, "/app/append-system-prompt.md",
    ]));
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--append-system-prompt", "/app/append-system-prompt.md",
    ]));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("binds the host-tools extension read-only and exposes the tool list via PI_HOST_TOOLS", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const extension = path.join(appRoot, "extensions", "host-tools.ts");
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    await mkdir(path.dirname(extension), { recursive: true });
    await writeFile(extension, "export default () => {};\n", { mode: 0o600 });
    const workerArgs = await buildPiRunBwrapArgs({
      workspace: f.workspace,
      appRoot,
      hostTools: "send,spawn,cancel",
    });
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--dir", "/app/extensions",
      "--ro-bind", await realpath(extension), "/app/extensions/host-tools.ts",
      "--setenv", "PI_HOST_TOOLS", "send,spawn,cancel",
    ]));
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--extension", "/app/extensions/host-tools.ts",
    ]));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("rejects a missing host-tools extension before building argv", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    await expect(buildPiRunBwrapArgs({ workspace: f.workspace, appRoot, hostTools: "send" }))
      .rejects.toThrow("Host tools extension must be a regular file");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("binds the multimodal extension read-only when present", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const multimodal = path.join(appRoot, "extensions", "multimodal.ts");
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    await mkdir(path.dirname(multimodal), { recursive: true });
    await writeFile(multimodal, "export default () => {};\n", { mode: 0o600 });
    const workerArgs = await buildPiRunBwrapArgs({
      workspace: f.workspace,
      appRoot,
    });
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--dir", "/app/extensions",
      "--ro-bind", await realpath(multimodal), "/app/extensions/multimodal.ts",
    ]));
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--extension", "/app/extensions/multimodal.ts",
    ]));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("mounts host-exposed files under /run outside the writable workspace", async () => {
  const f = await fixture();
  const appRoot = path.join(f.root, "app");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const runDir = path.join(f.root, "run");
  const timeline = path.join(f.root, "timeline.jsonl");
  const attachments = path.join(f.root, "attachments");
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
    await mkdir(runDir);
    await mkdir(attachments);
    await writeFile(timeline, "", "utf8");
    const workerArgs = await buildPiRunBwrapArgs({
      workspace: f.workspace,
      appRoot,
      hostSocketDir: runDir,
      hostTimeline: timeline,
      hostAttachments: attachments,
      agentToken: "secret-token",
    });
    expect(workerArgs.args).toEqual(expect.arrayContaining([
      "--bind", await realpath(runDir), "/run",
      "--ro-bind", await realpath(attachments), "/run/attachments",
      "--ro-bind", timeline, "/run/timeline.jsonl",
      "--remount-ro", "/run",
      "--setenv", "PI_HOST_SOCKET", "/run/host.sock",
      "--setenv", "PI_AGENT_TOKEN", "secret-token",
    ]));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


it("does not follow or clobber a write-probe symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-agent-probe-test-"));
  const dataDir = path.join(root, "data");
  const sentinel = path.join(root, "sentinel");
  const probe = path.join(dataDir, `.write-probe-${process.pid}`);
  const bwrap = path.join(root, "bwrap-probe");
  try {
    await mkdir(dataDir);
    await writeFile(sentinel, "sentinel");
    await symlink(sentinel, probe, "file");
    await writeFile(bwrap, "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
    await expect(checkSandboxEnvironment(dataDir, { bwrapPath: bwrap })).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("sentinel");
    expect((await lstat(probe)).isSymbolicLink()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("pins a directory against a later path swap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-agent-pin-test-"));
  const original = path.join(root, "original");
  const moved = path.join(root, "original-moved");
  const replacement = path.join(root, "replacement");
  try {
    await mkdir(original);
    await mkdir(replacement);
    const pinned = await openPinnedDirectory(original);
    const before = await pinned.handle.stat();
    await rename(original, moved);
    await rename(replacement, original);
    const after = await pinned.handle.stat();
    expect(after.ino).toBe(before.ino);
    expect(after.ino).not.toBe((await lstat(original)).ino);
    expect(pinned.realPath).toBe(original);
    expect(await realpath(pinned.path)).toBe(moved);
    await pinned.handle.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});


const integration = process.env.RUN_BWRAP_TESTS === "1" && bwrapAvailable() ? describe : describe.skip;
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

  it("cannot see host-only files outside the bound workspace", async () => {
    const f = await fixture();
    try {
      const hostOnly = path.join(f.root, "host-only");
      await mkdir(hostOnly);
      const canary = path.join(hostOnly, "canary.txt");
      await writeFile(canary, "must-not-leak\n");
      await access(canary);
      const result = await runSandbox(f, { executable: "/bin/bash", args: ["-lc", `test ! -e '${canary}'`] });
      expect(result.exitCode).toBe(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("reaches a host loopback server through the shared network namespace", async () => {
    const f = await fixture();
    const server = createServer((_req, res) => { res.end("pong"); });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const result = await runSandbox(f, { executable: "/usr/bin/curl", args: ["-s", `http://127.0.0.1:${port}/ping`] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("pong");
    } finally {
      await new Promise<void>((resolve) => {
        if (server.listening) server.close(() => resolve());
        else resolve();
      });
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("persists npm and uv cache writes back into the host workspace", async () => {
    const f = await fixture();
    try {
      const result = await runSandbox(f, {
        executable: "/bin/bash",
        args: ["-lc", 'mkdir -p "$NPM_CONFIG_CACHE" "$UV_CACHE_DIR"; echo npm-marker > "$NPM_CONFIG_CACHE/npm.txt"; echo uv-marker > "$UV_CACHE_DIR/uv.txt"'],
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(f.workspace, ".cache", "npm", "npm.txt"), "utf8")).toBe("npm-marker\n");
      expect(await readFile(path.join(f.workspace, ".cache", "uv", "uv.txt"), "utf8")).toBe("uv-marker\n");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("kills detached descendants when the sandbox process group is terminated", async () => {
    const f = await fixture();
    const marker = `tg-bot2-descendant-${process.pid}`;
    const pidFile = path.join(f.workspace, "descendant.pid");
    let child: ChildProcess | undefined;
    const stderr: string[] = [];
    try {
      const { args } = await buildBwrapArgs(f, {
        executable: "/bin/bash",
        args: ["-lc", `exec -a ${marker} sleep 300 & echo started; pgrep -f '^${marker}' > descendant.pid; wait`],
      });
      const proc = spawnProcess("bwrap", args, { stdio: ["ignore", "ignore", "pipe"], detached: true, env: {} });
      child = proc;
      proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      const appeared = await until(async () => {
        try { return /^\d+$/.test((await readFile(pidFile, "utf8")).trim()); }
        catch { return false; }
      }, 5_000);
      if (!appeared) throw new Error(`descendant did not appear in the sandbox; stderr: ${stderr.join("")}`);
      expect((await readFile(pidFile, "utf8")).trim()).toMatch(/^\d+$/);
      expect(hostPids(`^${marker}`)).toHaveLength(1);
      const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
      terminateProcessGroup(proc, "SIGKILL");
      await closed;
      expect(await until(() => hostPids(`^${marker}`).length === 0, 5_000)).toBe(true);
    } finally {
      if (child) terminateProcessGroup(child, "SIGKILL");
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
