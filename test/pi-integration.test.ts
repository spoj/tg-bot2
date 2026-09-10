import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PiWorker } from "../src/pi-worker.js";
import { checkSandboxEnvironment, spawnProcess, terminateProcessGroup } from "../src/sandbox.js";

// Opt-in integration gate: exercise the REAL bundled pi CLI (and bubblewrap)
// only when explicitly requested, so the default offline test run stays hermetic.
const integration = process.env.RUN_BWRAP_TESTS === "1" ? describe : describe.skip;

integration("Pi RPC integration in bwrap (requires RUN_BWRAP_TESTS=1)", () => {
  it("boots in bwrap, waits for RPC readiness, and handles prompt lifecycle without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tg-pi-rpc-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const hostSocketDir = path.join(root, "run");
    const hostTimeline = path.join(root, "timeline.jsonl");
    await mkdir(hostSocketDir);
    await writeFile(hostTimeline, "", "utf8");
    const appRoot = await realpath(process.cwd());
    const { bwrapPath } = await checkSandboxEnvironment(path.join(root, "data"));

    try {
      const worker = new PiWorker({
        workspace,
        appRoot,
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

      await worker.close();
      expect(worker.isAlive()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("uses profile settings while ignoring project resources and preserving the profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tg-pi-profile-"));
    const workspace = path.join(root, "workspace");
    const profile = path.join(workspace, ".pi", "agent");
    const project = path.join(workspace, ".pi");
    await mkdir(path.join(profile, "extensions"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(project, "extensions"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(profile, "AGENTS.md"), "profile-agent-marker\n", { mode: 0o600 });
    await writeFile(path.join(profile, "extensions", "probe.mjs"), `import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.registerProvider("profile-probe", {
    name: "Profile probe",
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    apiKey: "profile-probe",
    models: [{
      id: "profile-model",
      name: "Profile model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 256,
    }],
  });
  pi.on("session_start", (_event, ctx) => {
    writeFileSync("/workspace/profile-probe.json", JSON.stringify({
      provider: ctx.model?.provider ?? null,
      model: ctx.model?.id ?? null,
      thinkingLevel: ctx.thinkingLevel ?? null,
      projectTrusted: ctx.isProjectTrusted(),
      profileInstructionsLoaded: ctx.getSystemPrompt().includes("profile-agent-marker"),
    }));
  });
}
`, { mode: 0o600 });
    await writeFile(path.join(project, "extensions", "must-not-load.mjs"), `export default function () {
  throw new Error("project extension loaded despite --no-approve");
}
`, { mode: 0o600 });
    const profileSettings = {
      extensions: ["extensions/probe.mjs"],
      defaultProvider: "profile-probe",
      defaultModel: "profile-model",
      defaultThinkingLevel: "high",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    };
    const profileSettingsPath = path.join(profile, "settings.json");
    const profileSettingsText = `${JSON.stringify(profileSettings, null, 2)}\n`;
    await writeFile(profileSettingsPath, profileSettingsText, { mode: 0o600 });
    await writeFile(path.join(project, "settings.json"), JSON.stringify({
      defaultProvider: "project-provider",
      defaultModel: "project-model",
      extensions: ["extensions/must-not-load.mjs"],
    }, null, 2) + "\n", { mode: 0o600 });

    const hostSocketDir = path.join(root, "run");
    const hostTimeline = path.join(root, "timeline.jsonl");
    await mkdir(hostSocketDir);
    await writeFile(hostTimeline, "", "utf8");
    const appRoot = await realpath(process.cwd());
    const { bwrapPath } = await checkSandboxEnvironment(path.join(root, "data"));

    try {
      const worker = new PiWorker({
        workspace,
        appRoot,
        bwrapPath,
        spawnProcess,
        terminateProcessGroup,
        hostSocketDir,
        hostTimeline,
        idleTimeoutMs: 60_000,
      });

      await worker.start();
      expect(worker.isAlive()).toBe(true);
      await expect(readFile(path.join(workspace, "profile-probe.json"), "utf8")).resolves.toBe(
        JSON.stringify({
          provider: "profile-probe",
          model: "profile-model",
          thinkingLevel: "high",
          projectTrusted: false,
          profileInstructionsLoaded: true,
        }),
      );
      await expect(readFile(profileSettingsPath, "utf8")).resolves.toBe(profileSettingsText);

      await worker.close();
      expect(worker.isAlive()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

});
