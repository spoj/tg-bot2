import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiRunBwrapArgs, checkSandboxEnvironment, terminateProcessGroup } from "../src/sandbox.js";

// Opt-in integration gate: exercise the REAL bundled pi CLI (and bubblewrap)
// only when explicitly requested, so the default offline test run stays hermetic.
const integration = process.env.RUN_BWRAP_TESTS === "1" ? describe : describe.skip;

const EXIT_TIMEOUT_MS = 120_000;

type OneShotRun = {
  root: string;
  workspace: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

async function runOneShot(message: string, extra: Partial<Parameters<typeof buildPiRunBwrapArgs>[0]> = {}, workspace?: string): Promise<OneShotRun> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-pi-print-"));
  const targetWorkspace = workspace ?? path.join(root, "workspace");
  await mkdir(targetWorkspace, { recursive: true, mode: 0o700 });
  // The bundled CLI lives in this repository's own node_modules; the repo root
  // is the appRoot, exactly as the production worker treats it.
  const appRoot = await realpath(process.cwd());
  const { bwrapPath } = await checkSandboxEnvironment(path.join(root, "data"));
  const { args } = await buildPiRunBwrapArgs({ workspace: targetWorkspace, appRoot, ...extra });
  const child = spawn(bwrapPath, args, { detached: true, env: {}, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    child.stdin?.end(message, "utf8");
  } catch {
    terminateProcessGroup(child, "SIGKILL");
  }
  const timer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), EXIT_TIMEOUT_MS);
  const result = await exited;
  clearTimeout(timer);
  return { root, workspace: targetWorkspace, ...result, stderr, stdout };
}

integration("Pi one-shot print integration (requires RUN_BWRAP_TESTS=1)", () => {
  it("exits on its own after a credential-less turn, reporting the missing model", async () => {
    const run = await runOneShot("hi");
    try {
      // Without credentials the CLI resolves no model and exits non-zero; the
      // point of this test is the one-shot lifecycle: process exits by itself.
      expect(run.signal).toBeNull();
      expect(run.code).not.toBe(0);
      expect(run.stderr.toLowerCase()).toMatch(/model|api key|authentication/);
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("a resume run over a sessionless workspace still exits on its own", async () => {
    // --continue with no prior session must not hang or crash before model
    // resolution: the credential-less exit path is the same for both modes.
    const first = await runOneShot("hi");
    try {
      expect(first.signal).toBeNull();
      expect(first.code).not.toBe(0);
      const second = await runOneShot("hi", { resume: true }, first.workspace);
      try {
        expect(second.signal).toBeNull();
        expect(second.code).not.toBe(0);
      } finally {
        await rm(second.root, { recursive: true, force: true });
      }
    } finally {
      await rm(first.root, { recursive: true, force: true });
    }
  }, 180_000);
});
