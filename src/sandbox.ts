import { constants as fsConstants, existsSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { errorCode, requireRealDirectory } from "./util.js";
export type PiWorkerChildProcess = ChildProcess;
type PiWorkerSpawnOptions = Omit<SpawnOptions, "env"> & { env?: NodeJS.ProcessEnv };
export type PiWorkerSpawn = (executable: string, args: string[], options: PiWorkerSpawnOptions) => ChildProcess;
export { spawnProcess };

/** Terminate the process group, then the child if needed. */
export function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && child.pid > 0) {
    terminatePid(child.pid, signal);
    return;
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

/** Terminate a process group by PID, then the PID itself if needed. */
export function terminatePid(pid: number, signal: NodeJS.Signals): void {
  if (pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group may exit before signalling.
    }
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}
export type SandboxPaths = { workspace: string; sessions: string; readOnlyPaths?: string[] };
export type SandboxRequest = {
  executable: string;
  args: string[];
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
};
export type SandboxResult = {
  exitCode: number | null;
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};
export type SandboxOptions = { maxOutputBytes?: number; bwrapPath?: string };

const DEFAULT_LIMIT = 50_000;
const DEFAULT_TIMEOUT = 120_000;
const activeProcesses = new Set<ChildProcess>();

async function existing(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of paths) {
    try {
      await access(candidate, fsConstants.R_OK);
      found.push(candidate);
    } catch { /* unavailable optional path */ }
  }
  return found;
}
async function runtimeLibraryPaths(): Promise<string[]> {
  const entries = await readdir("/", { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.name.startsWith("lib") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => path.join("/", entry.name));
  return await existing(candidates);
}

export async function buildBwrapArgs(
  paths: SandboxPaths,
  request: SandboxRequest,
): Promise<{ args: string[] }> {
  const sessions = await requireRealDirectory(paths.sessions, "Sandbox sessions", path.resolve(paths.sessions));
  const workspace = await requireRealDirectory(paths.workspace, "Sandbox workspace", path.resolve(paths.workspace));
  const mountPoint = path.join(workspace, "sessions_ro");
  await mkdir(mountPoint, { recursive: true, mode: 0o700 });
  const mountStat = await lstat(mountPoint);
  if (!mountStat.isDirectory()) {
    throw new Error("workspace/sessions_ro must be a real directory mount point");
  }

  const tailArgs: string[] = [];
  for (const candidate of paths.readOnlyPaths ?? []) {
    let resolved: string;
    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink()) throw new Error("Sandbox read-only paths must not be symlinks");
      resolved = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const relative = path.relative(workspace, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Sandbox read-only paths must remain under the workspace");
    }
    tailArgs.push("--ro-bind", resolved, path.posix.join("/workspace", relative.split(path.sep).join("/")));
  }
  tailArgs.push("--ro-bind", sessions, "/workspace/sessions_ro");

  const args: string[] = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
    "--unshare-ipc", "--unshare-uts", "--share-net", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
  ];
  for (const runtimePath of await existing(["/bin", "/lib", "/lib64"])) {
    args.push("--ro-bind", runtimePath, runtimePath);
  }
  args.push("--dir", "/etc");
  for (const etcPath of await existing(["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/pki", "/etc/ca-certificates"])) {
    args.push("--ro-bind", etcPath, etcPath);
  }
  args.push(
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, "/workspace",
    ...tailArgs,
    "--setenv", "HOME", "/workspace",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "NPM_CONFIG_CACHE", "/workspace/.cache/npm",
    "--setenv", "NPM_CONFIG_PREFIX", "/workspace/.local",
    "--setenv", "UV_CACHE_DIR", "/workspace/.cache/uv",
    "--setenv", "UV_TOOL_BIN_DIR", "/workspace/.local/bin",
    "--setenv", "UV_TOOL_DIR", "/workspace/.local/share/uv/tools",
    "--setenv", "UV_PYTHON_INSTALL_DIR", "/workspace/.python",
  );
  args.push("--chdir", "/workspace", "--", request.executable, ...request.args);
  return { args };
}

export type PiRunSandboxPaths = {
  workspace: string;
  appRoot: string;
  cliPath?: string;
  appendSystemPrompt?: string;
  /** In-sandbox directory for session files; defaults to /workspace/.pi/sessions. */
  sessionDir?: string;
  /** Continue the latest session in sessionDir instead of creating a new session. */
  continueSession?: boolean;
  /** "provider/modelId" passed at launch so session restoration cannot override the configured model. */
  model?: string;
  /** Thinking level passed at launch with the configured model. */
  thinkingLevel?: string;
  /** Comma-separated host tool names exposed via the mounted host-tools extension and PI_HOST_TOOLS. */
  hostTools?: string;
  /** Host-issued capability token passed as PI_AGENT_TOKEN. */
  agentToken?: string;
  /** Host-owned runtime directory bind-mounted read-only at /run. */
  hostSocketDir?: string;
  /** Host-owned global timeline exposed read-only at /run/timeline.jsonl. */
  hostTimeline?: string;
  /** Host-managed attachments exposed read-only at /run/attachments. */
  hostAttachments?: string;
};
export type PiRunBwrapResult = { args: string[] };

function relativeMountPath(root: string, candidate: string, mountPoint: string, label: string): string {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain under ${root}`);
  }
  return relative.length === 0 ? mountPoint : path.posix.join(mountPoint, relative.split(path.sep).join("/"));
}

type ExtensionConfig = {
  hostToolsExtension: string | undefined;
  hostTools: string | undefined;
  multimodalExtension: string | undefined;
};

function buildExtensionMountArgs(config: ExtensionConfig): { mountArgs: string[]; cliArgs: string[] } {
  const mountArgs: string[] = [];
  const cliArgs: string[] = [];
  if (config.hostToolsExtension !== undefined || config.multimodalExtension !== undefined) {
    mountArgs.push("--dir", "/app/extensions");
  }
  if (config.hostToolsExtension !== undefined) {
    mountArgs.push(
      "--ro-bind", config.hostToolsExtension, "/app/extensions/host-tools.ts",
      "--setenv", "PI_HOST_TOOLS", config.hostTools!,
    );
    cliArgs.push("--extension", "/app/extensions/host-tools.ts");
  }
  if (config.multimodalExtension !== undefined) {
    mountArgs.push("--ro-bind", config.multimodalExtension, "/app/extensions/multimodal.ts");
    cliArgs.push("--extension", "/app/extensions/multimodal.ts");
  }
  return { mountArgs, cliArgs };
}

async function resolveNodeModulesAndCli(appRoot: string, requestedCli?: string): Promise<{ nodeModules: string; cliMountPath: string }> {
  const nodeModulesPath = path.join(appRoot, "node_modules");
  const nodeModulesStat = await lstat(nodeModulesPath);
  if (!nodeModulesStat.isDirectory()) {
    throw new Error("Pi worker node_modules must be a real directory");
  }
  const nodeModules = await realpath(nodeModulesPath);
  const nodeModulesRelative = path.relative(appRoot, nodeModules);
  if (nodeModulesRelative === ".." || nodeModulesRelative.startsWith(`..${path.sep}`) || path.isAbsolute(nodeModulesRelative)) {
    throw new Error("Pi worker node_modules canonical target must remain under appRoot");
  }
  const defaultCli = path.join(nodeModules, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const targetCli = requestedCli ?? defaultCli;
  const hostCliPath = targetCli.startsWith("/app/node_modules/")
    ? path.join(nodeModules, targetCli.slice("/app/node_modules/".length))
    : path.isAbsolute(targetCli) ? targetCli : path.resolve(appRoot, targetCli);
  const cliStat = await lstat(hostCliPath);
  const cliPath = await realpath(hostCliPath);
  if (!cliStat.isFile()) throw new Error("Pi worker CLI must be a regular file");
  const cliMountPath = relativeMountPath(nodeModules, cliPath, "/app/node_modules", "Pi worker CLI");
  return { nodeModules, cliMountPath };
}

/** Build the Pi one-shot run profile; appRoot, source, and .env stay out while dependencies remain read-only. */
export async function buildPiRunBwrapArgs(paths: PiRunSandboxPaths): Promise<PiRunBwrapResult> {
  const workspace = await requireRealDirectory(paths.workspace, "Pi worker workspace", path.resolve(paths.workspace));
  const appRoot = await requireRealDirectory(paths.appRoot, "Pi worker appRoot", path.resolve(paths.appRoot));
  const { nodeModules, cliMountPath } = await resolveNodeModulesAndCli(appRoot, paths.cliPath);

  const hostToolsExtension = paths.hostTools === undefined
    ? undefined
    : await requireHostToolsExtension(appRoot);
  const multimodalExtension = await findExtension(appRoot, "multimodal.ts");
  const { mountArgs, cliArgs } = buildExtensionMountArgs({
    hostToolsExtension,
    hostTools: paths.hostTools,
    multimodalExtension,
  });
  const nodePath = await requireExecutable("node");
  const runtimePaths = [...(await existing(["/bin"])), ...(await runtimeLibraryPaths())];
  const args: string[] = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
    "--unshare-ipc", "--unshare-uts", "--share-net", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
  ];
  for (const runtimePath of runtimePaths) {
    args.push("--ro-bind", runtimePath, runtimePath);
  }
  // requireExecutable returns the canonical realpath, so dirname() is the real parent
  // dir even through symlink chains; skip when an already-bound prefix covers it.
  const nodeDir = path.dirname(nodePath);
  if (nodeDir !== "/" && !["/usr", ...runtimePaths].some((prefix) => nodeDir === prefix || nodeDir.startsWith(`${prefix}/`))) {
    args.push("--ro-bind", nodeDir, nodeDir);
  }
  // DNS/TLS/fonts that Chrome (launched by the agent inside the sandbox) and other
  // tools need; ro-bound individually so nothing host-private leaks in.
  const chromeSupportPaths = [
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl", "/etc/pki",
    "/etc/ca-certificates", "/etc/fonts", "/usr/share/fonts", "/usr/share/fontconfig",
  ].filter((candidate) => existsSync(candidate));
  args.push(
    ...chromeSupportPaths.flatMap((entry) => ["--ro-bind", entry, entry]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/app",
    "--ro-bind", nodeModules, "/app/node_modules",
    // Root-level agent scripts resolve harness dependencies (e.g. puppeteer-core)
    // through the same read-only tree; subdirectory projects keep their own installs.
    "--ro-bind", nodeModules, "/workspace/node_modules",
    ...(paths.appendSystemPrompt === undefined ? [] : ["--ro-bind", paths.appendSystemPrompt, "/app/append-system-prompt.md"]),
    ...mountArgs,
    "--bind", workspace, "/workspace",
    ...(paths.hostSocketDir === undefined
      ? []
      : ["--bind", await requireRealDirectory(paths.hostSocketDir, "Host runtime directory"), "/run"]),
    ...(paths.hostAttachments === undefined
      ? []
      : ["--ro-bind", await requireRealDirectory(paths.hostAttachments, "Host attachments directory"), "/run/attachments"]),
    ...(paths.hostTimeline === undefined
      ? []
      : ["--ro-bind", paths.hostTimeline, "/run/timeline.jsonl"]),
    ...(paths.hostSocketDir === undefined ? [] : ["--remount-ro", "/run"]),
    ...(paths.hostSocketDir === undefined ? [] : ["--setenv", "PI_HOST_SOCKET", "/run/host.sock"]),
    "--setenv", "HOME", "/workspace",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/workspace/.local/bin:/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "PI_CODING_AGENT_DIR", "/workspace/.pi/agent",
    "--setenv", "NPM_CONFIG_CACHE", "/workspace/.cache/npm",
    "--setenv", "NPM_CONFIG_PREFIX", "/workspace/.local",
    "--setenv", "UV_CACHE_DIR", "/workspace/.cache/uv",
    "--setenv", "UV_TOOL_BIN_DIR", "/workspace/.local/bin",
    "--setenv", "UV_TOOL_DIR", "/workspace/.local/share/uv/tools",
    "--setenv", "UV_PYTHON_INSTALL_DIR", "/workspace/.python",
    ...(paths.agentToken === undefined ? [] : ["--setenv", "PI_AGENT_TOKEN", paths.agentToken]),
  );
  const piArgs = [
    "--mode", "rpc",
    "--session-dir", paths.sessionDir ?? "/workspace/.pi/sessions",
    ...(paths.continueSession === true ? ["--continue"] : []),
    "--approve",
    ...(paths.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", "/app/append-system-prompt.md"]),
    ...cliArgs,
    ...(paths.model === undefined ? [] : ["--model", paths.model]),
    ...(paths.thinkingLevel === undefined ? [] : ["--thinking", paths.thinkingLevel]),
  ];
  args.push("--chdir", "/workspace", "--", nodePath, cliMountPath, ...piArgs);
  return { args };
}

async function requireHostToolsExtension(appRoot: string): Promise<string> {
  const extensionPath = path.join(appRoot, "extensions", "host-tools.ts");
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(extensionPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error("Host tools extension must be a regular file");
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Host tools extension must be a regular file");
  }
  return await realpath(extensionPath);
}
async function findExtension(appRoot: string, name: string): Promise<string | undefined> {
  const extensionPath = path.join(appRoot, "extensions", name);
  try {
    const stat = await lstat(extensionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return undefined;
    }
    return await realpath(extensionPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function outputCapture(limit: number): {
  stdout: { add(chunk: Buffer): void; buffer(): Buffer; text(): string };
  stderr: { add(chunk: Buffer): void; text(): string };
  readonly truncated: boolean;
} {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let remaining = limit;
  let wasTruncated = false;
  const add = (chunks: Buffer[]) => (chunk: Buffer): void => {
    if (chunk.length > remaining) wasTruncated = true;
    if (remaining <= 0) return;
    const accepted = chunk.subarray(0, remaining);
    chunks.push(accepted);
    remaining -= accepted.length;
  };
  let materialized: Buffer | undefined;
  const stdout = (): Buffer => (materialized ??= Buffer.concat(stdoutChunks));
  return {
    stdout: {
      add: add(stdoutChunks),
      buffer: stdout,
      text: () => stdout().toString("utf8"),
    },
    stderr: {
      add: add(stderrChunks),
      text: () => Buffer.concat(stderrChunks).toString("utf8"),
    },
    get truncated() { return wasTruncated; },
  };
}

export async function runSandbox(
  paths: SandboxPaths,
  request: SandboxRequest,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("timeoutMs must be a positive safe integer no larger than 2147483647");
  }
  const { args } = await buildBwrapArgs(paths, request);
  const limit = request.maxOutputBytes ?? options.maxOutputBytes ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("maxOutputBytes must be a positive integer");
  const capture = outputCapture(limit);

  return new Promise<SandboxResult>((resolve, reject) => {
    const child = spawnProcess(options.bwrapPath ?? "bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {},
    });
    activeProcesses.add(child);
    let timedOut = false;
    let settled = false;
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      terminateProcessGroup(child, "SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses.delete(child);
      terminate();
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => capture.stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => capture.stderr.add(chunk));
    child.once("error", rejectOnce);
    child.stdin.on("error", rejectOnce);
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses.delete(child);
      resolve({
        exitCode,
        stdout: capture.stdout.text(),
        stdoutBuffer: capture.stdout.buffer(),
        stderr: capture.stderr.text(),
        timedOut,
        truncated: capture.truncated,
      });
    });
    if (request.stdin === undefined) child.stdin.end();
    else child.stdin.end(request.stdin);
  });
}

export function terminateActiveSandboxes(): void {
  for (const child of activeProcesses) {
    terminateProcessGroup(child, "SIGKILL");
  }
}

async function requireExecutable(executable: string): Promise<string> {
  const candidates = executable.includes(path.sep)
    ? [executable]
    : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(path.delimiter).map((dir) => path.join(dir, executable));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const stat = await lstat(resolved);
      if (!stat.isFile()) continue;
      await access(resolved, fsConstants.X_OK);
      return resolved;
    } catch {}
  }
  throw new Error(`Executable not found or not executable: ${executable}`);
}

export type SandboxEnvironment = { dataDir: string; bwrapPath: string };

export async function checkSandboxEnvironment(dataDir: string, options: SandboxOptions = {}): Promise<SandboxEnvironment> {
  const bwrapPath = await requireExecutable(options.bwrapPath ?? "bwrap");
  const nodePath = await requireExecutable("node");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const writeProbe = path.join(dataDir, `.write-probe-${process.pid}`);
  const probe = await open(
    writeProbe,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await probe.writeFile("ok");
  } finally {
    await probe.close();
    await rm(writeProbe, { force: true });
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-probe-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const nodeResult = await runSandbox(
      { workspace, sessions },
      { executable: "/bin/bash", args: ["-lc", `${shellQuote(nodePath)} --version`], timeoutMs: 30_000 },
      { ...options, bwrapPath },
    );
    if (nodeResult.exitCode !== 0 || nodeResult.timedOut) {
      throw new Error(`Sandbox node probe failed (${nodeResult.exitCode ?? "signal"}): ${nodeResult.stderr || nodeResult.stdout}`);
    }
    // uv/rg are checked lazily: warn when missing but never block boot, so the
    // agent discovers them at use time instead of the whole bot refusing to start.
    for (const tool of ["uv", "rg"]) {
      const probe = await runSandbox(
        { workspace, sessions },
        { executable: "/bin/bash", args: ["-lc", `command -v ${shellQuote(tool)} >/dev/null 2>&1`], timeoutMs: 30_000 },
        { ...options, bwrapPath },
      );
      if (probe.exitCode !== 0) {
        console.warn(`Sandbox tool "${tool}" is unavailable; features relying on it may fail at runtime.`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { dataDir: await realpath(dataDir), bwrapPath };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
