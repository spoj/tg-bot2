import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runSandbox, type SandboxPaths, type SandboxRequest, type SandboxResult } from "./sandbox.js";

export type SandboxRunner = (paths: SandboxPaths, request: SandboxRequest) => Promise<SandboxResult>;
export type ToolOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  runner?: SandboxRunner;
};

function render(result: SandboxResult, options: { noMatches?: boolean } = {}): string {
  if (options.noMatches && result.exitCode === 1 && !result.timedOut) return "No matches.";
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.trimEnd());
  if (result.stderr) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  parts.push(`exit code: ${result.exitCode === null ? "terminated by signal" : result.exitCode}`);
  if (result.timedOut) parts.push("[tool timed out]");
  if (result.truncated) parts.push("[output truncated at configured byte limit]");
  return parts.join("\n") || "(no output)";
}

function toolResult(result: SandboxResult, text = render(result)) {
  return {
    content: [{ type: "text" as const, text }],
    details: { exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated },
    isError: result.timedOut || result.exitCode !== 0,
  };
}

export function createTools(paths: SandboxPaths, options: ToolOptions): ToolDefinition[] {
  const runner: SandboxRunner = options.runner ?? ((p, request) =>
    runSandbox(p, request, { maxOutputBytes: options.maxOutputBytes }));
  const invoke = (request: SandboxRequest) => runner(paths, { ...request, timeoutMs: request.timeoutMs ?? options.timeoutMs });

  const readTool = defineTool({
    name: "read",
    label: "Read",
    description: "Read a text file visible in the sandbox. Relative paths start at /workspace.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    execute: async (_id, params) => toolResult(await invoke({ executable: "/bin/cat", args: ["--", params.path] })),
  });

  const writeTool = defineTool({
    name: "write",
    label: "Write",
    description: "Create parent directories and replace a file in the writable workspace.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const content = Buffer.from(params.content, "utf8");
      const result = await invoke({
        executable: "/bin/bash",
        args: ["-c", "set -e; target=$1; parent=${target%/*}; if [ \"$parent\" != \"$target\" ]; then mkdir -p -- \"$parent\"; fi; cat > \"$target\"", "write-tool", params.path],
        stdin: content,
      });
      return toolResult(result, result.exitCode === 0 && !result.timedOut
        ? `Wrote ${content.length} bytes to ${params.path}.`
        : render(result));
    },
  });

  const grepTool = defineTool({
    name: "grep",
    label: "Grep",
    description: "Case-insensitive fixed-string search with filenames and line numbers.",
    parameters: Type.Object({
      query: Type.String(),
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    execute: async (_id, params) => {
      const result = await invoke({
        executable: "/usr/bin/rg",
        args: ["-F", "-i", "-n", "--with-filename", "--", params.query, params.path ?? "/workspace"],
      });
      if (result.exitCode === 1 && !result.timedOut) {
        return { content: [{ type: "text" as const, text: "No matches." }], details: { ...result }, isError: false };
      }
      return toolResult(result);
    },
  });

  const bashTool = defineTool({
    name: "bash",
    label: "Bash",
    description: "Run an exact shell command in /workspace with network access and workspace-local package paths.",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, params) => toolResult(await invoke({
      executable: "/bin/bash",
      args: ["-lc", params.command],
    })),
  });

  return [readTool, writeTool, grepTool, bashTool];
}
