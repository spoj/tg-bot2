import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PiWorker } from "../src/pi-worker.js";
import { checkSandboxEnvironment, spawnProcess, terminateProcessGroup } from "../src/sandbox.js";

// Opt-in integration gate: exercise the REAL bundled pi CLI (and bubblewrap)
// only when explicitly requested, so the default offline test run stays hermetic.
const integration = process.env.RUN_BWRAP_TESTS === "1" ? describe : describe.skip;

integration("Pi RPC integration in bwrap (requires RUN_BWRAP_TESTS=1)", () => {
  it("boots in bwrap, configures modes, and handles prompt lifecycle without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tg-pi-rpc-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const hostSocketDir = path.join(root, "run");
    const hostTimeline = path.join(root, "timeline.jsonl");
    await mkdir(hostSocketDir);
    await writeFile(hostTimeline, "", "utf8");
    const appRoot = await realpath(process.cwd());
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir);
    const { bwrapPath } = await checkSandboxEnvironment(path.join(root, "data"));

    try {
      const worker = new PiWorker({
        workspace,
        appRoot,
        agentDir,
        bwrapPath,
        spawnProcess,
        terminateProcessGroup,
        hostSocketDir,
        hostTimeline,
        idleTimeoutMs: 60_000,
      });

      await worker.start();
      expect(worker.isAlive()).toBe(true);

      await expect(worker.prompt("hi")).rejects.toThrow("No API key found");
      expect(worker.isBusy()).toBe(false);

      await worker.close();
      expect(worker.isAlive()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

});
