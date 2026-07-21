import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type SandboxPaths = { workspace: string; sessions: string };
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
    } catch { /* optional mount absent */ }
  }
  return found;
}

export async function buildBwrapArgs(
  paths: SandboxPaths,
  request: SandboxRequest,
): Promise<{ args: string[]; resolved: SandboxPaths }> {
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
  args.push(
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, "/workspace",
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
  const { args } = await buildBwrapArgs(paths, request);
  const limit = request.maxOutputBytes ?? options.maxOutputBytes ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("maxOutputBytes must be a positive integer");
  const capture = outputCapture(limit);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT;

  return await new Promise<SandboxResult>((resolve, reject) => {
    const child = spawn(options.bwrapPath ?? "bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {},
    });
    activeProcesses.add(child);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => capture.stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => capture.stderr.add(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses.delete(child);
      reject(error);
    });
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
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
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
    } catch { /* keep searching */ }
  }
  throw new Error(`Executable not found or not executable: ${executable}`);
}

export async function checkSandboxEnvironment(dataDir: string, options: SandboxOptions = {}): Promise<void> {
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
}
