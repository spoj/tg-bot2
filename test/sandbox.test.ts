import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBwrapArgs, runSandbox } from "../src/sandbox.js";

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
    expect(built.args).not.toContain("/");
    expect(built.args.slice(-3)).toEqual(["--", "/bin/cat", "x;bad"]);
    expect(built.args).toContain("/workspace/sessions_ro");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const integration = process.env.RUN_BWRAP_TESTS === "1" ? describe : describe.skip;
integration("Bubblewrap integration", () => {
  it("persists workspace, reads sessions, blocks writes, hides secrets, truncates, and times out", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.sessions, "history.jsonl"), "needle\n");
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
