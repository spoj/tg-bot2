import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
export { spawnProcess };
export type PiWorkerChildProcess = ChildProcess;
export type PiWorkerSpawnOptions = Omit<SpawnOptions, "env"> & { env?: NodeJS.ProcessEnv };
export type PiWorkerSpawn = (executable: string, args: string[], options: PiWorkerSpawnOptions) => ChildProcess;

/** Terminate the process group, then the child if needed. */
export function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && child.pid !== null && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may exit before signalling.
    }
  }
  try { child.kill(signal); } catch { /* already exited */ }
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
): Promise<{ args: string[]; resolved: SandboxPaths }> {
  const sessionsStat = await lstat(paths.sessions);
  if (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink()) {
    throw new Error("Sandbox sessions must be a real directory");
  }
  const workspace = await realpath(paths.workspace);
  const sessions = await realpath(paths.sessions);
  if (workspace !== path.resolve(paths.workspace) || sessions !== path.resolve(paths.sessions)) {
    throw new Error("Sandbox workspace and session paths must be resolved canonical directories");
  }
  const mountPoint = path.join(workspace, "sessions_ro");
  await mkdir(mountPoint, { recursive: true, mode: 0o700 });
  const mountStat = await lstat(mountPoint);
  if (!mountStat.isDirectory() || mountStat.isSymbolicLink()) {
    throw new Error("workspace/sessions_ro must be a real directory mount point");
  }

  const args = [
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
  const protectedMounts: Array<[string, string]> = [];
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
    protectedMounts.push([resolved, path.posix.join("/workspace", relative.split(path.sep).join("/"))]);
  }
  args.push(
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, "/workspace",
  );
  for (const [source, target] of protectedMounts) args.push("--ro-bind", source, target);
  args.push(
    "--ro-bind", sessions, "/workspace/sessions_ro",
    "--setenv", "HOME", "/workspace",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "NPM_CONFIG_CACHE", "/workspace/.cache/npm",
    "--setenv", "NPM_CONFIG_PREFIX", "/workspace/.local",
    "--setenv", "UV_CACHE_DIR", "/workspace/.cache/uv",
    "--setenv", "UV_TOOL_BIN_DIR", "/workspace/.local/bin",
    "--setenv", "UV_TOOL_DIR", "/workspace/.local/share/uv/tools",
    "--setenv", "UV_PYTHON_INSTALL_DIR", "/workspace/.python",
    "--chdir", "/workspace", "--", request.executable, ...request.args,
  );
  return { args, resolved: { workspace, sessions } };
}

export type PiWorkerSandboxPaths = {
  workspace: string;
  appRoot: string;
  cliPath?: string;
  appendSystemPrompt?: string;
};
export type PiWorkerBwrapResult = { args: string[]; resolved: { workspace: string; appRoot: string; cliPath: string } };

function relativeMountPath(root: string, candidate: string, mountPoint: string, label: string): string {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain under ${root}`);
  }
  return relative.length === 0 ? mountPoint : path.posix.join(mountPoint, relative.split(path.sep).join("/"));
}

/** Build the Pi worker profile; appRoot, source, and .env stay out while dependencies remain read-only. */
export async function buildPiWorkerBwrapArgs(paths: PiWorkerSandboxPaths): Promise<PiWorkerBwrapResult> {
  const workspace = await realpath(paths.workspace);
  const appRoot = await realpath(paths.appRoot);
  if (workspace !== path.resolve(paths.workspace) || appRoot !== path.resolve(paths.appRoot)) {
    throw new Error("Pi worker workspace and appRoot must be resolved canonical directories");
  }
  const workspaceStat = await lstat(workspace);
  const appRootStat = await lstat(appRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Pi worker workspace must be a real directory");
  }
  if (!appRootStat.isDirectory() || appRootStat.isSymbolicLink()) {
    throw new Error("Pi worker appRoot must be a real directory");
  }

  const nodeModulesPath = path.join(appRoot, "node_modules");
  const nodeModulesStat = await lstat(nodeModulesPath);
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    throw new Error("Pi worker node_modules must be a real directory");
  }
  const nodeModules = await realpath(nodeModulesPath);
  const nodeModulesRelative = path.relative(appRoot, nodeModules);
  if (nodeModulesRelative === ".." || nodeModulesRelative.startsWith(`..${path.sep}`) || path.isAbsolute(nodeModulesRelative)) {
    throw new Error("Pi worker node_modules canonical target must remain under appRoot");
  }
  const defaultCli = path.join(nodeModules, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const requestedCli = paths.cliPath ?? defaultCli;
  const hostCliPath = requestedCli.startsWith("/app/node_modules/")
    ? path.join(nodeModules, requestedCli.slice("/app/node_modules/".length))
    : path.isAbsolute(requestedCli) ? requestedCli : path.resolve(appRoot, requestedCli);
  const cliStat = await lstat(hostCliPath);
  const cliPath = await realpath(hostCliPath);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) throw new Error("Pi worker CLI must be a regular file");
  const cliMountPath = relativeMountPath(nodeModules, cliPath, "/app/node_modules", "Pi worker CLI");

  const args = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
    "--unshare-ipc", "--unshare-uts", "--share-net", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
  ];
  for (const runtimePath of await existing(["/bin"])) {
    args.push("--ro-bind", runtimePath, runtimePath);
  }
  for (const runtimePath of await runtimeLibraryPaths()) {
    args.push("--ro-bind", runtimePath, runtimePath);
  }
  args.push("--dir", "/etc");
  for (const etcPath of await existing(["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/pki", "/etc/ca-certificates"])) {
    args.push("--ro-bind", etcPath, etcPath);
  }
  args.push(
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", nodeModules, "/app/node_modules", "--bind", workspace, "/workspace",
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
    "--chdir", "/workspace", "--", "/usr/bin/node", cliMountPath,
    "--mode", "rpc", "--continue", "--session-dir", "/workspace/.pi/sessions", "--approve",
    ...(paths.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", paths.appendSystemPrompt]),
  );
  return { args, resolved: { workspace, appRoot, cliPath } };
}

function outputCapture(limit: number): {
  stdout: { add(chunk: Buffer): void; buffer(): Buffer; text(): string };
  stderr: { add(chunk: Buffer): void; buffer(): Buffer; text(): string };
  readonly truncated: boolean;
} {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let remaining = limit;
  let wasTruncated = false;
  const collector = (chunks: Buffer[]) => ({
    add(chunk: Buffer) {
      if (chunk.length > remaining) wasTruncated = true;
      if (remaining <= 0) return;
      const accepted = chunk.subarray(0, remaining);
      chunks.push(accepted);
      remaining -= accepted.length;
    },
    buffer: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
  return {
    stdout: collector(stdoutChunks),
    stderr: collector(stderrChunks),
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
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Executable not found or not executable: ${executable}`);
}

export async function checkSandboxEnvironment(dataDir: string, options: SandboxOptions = {}): Promise<string> {
  const bwrapPath = await requireExecutable(options.bwrapPath ?? "bwrap");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const writeProbe = path.join(dataDir, `.write-probe-${process.pid}`);
  await writeFile(writeProbe, "ok", { mode: 0o600 });
  await rm(writeProbe);
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-probe-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const result = await runSandbox(
      { workspace, sessions },
      { executable: "/bin/bash", args: ["-lc", "node --version && uv --version && rg --version"], timeoutMs: 30_000 },
      { ...options, bwrapPath },
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Sandbox runtime probe failed (${result.exitCode ?? "signal"}): ${result.stderr || result.stdout}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return await realpath(dataDir);
}
