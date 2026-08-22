import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
    const appRoot = await realpath(process.cwd());
    const { bwrapPath } = await checkSandboxEnvironment(path.join(root, "data"));

    try {
      const worker = new PiWorker({
        workspace,
        appRoot,
        bwrapPath,
        spawnProcess,
        terminateProcessGroup,
        idleTimeoutMs: 60_000,
      });

      await worker.start();
      expect(worker.isAlive()).toBe(true);

      // Prompt without credentials will either fail preflight or emit error response
      await worker.prompt("hi");
      expect(worker.isBusy()).toBe(true);

      await worker.close();
      expect(worker.isAlive()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

});
