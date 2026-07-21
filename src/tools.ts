import { Type } from "typebox";
import * as photon from "@silvia-odwyer/photon-node";
import {
  DEFAULT_MAX_LINES,
  defineTool,
  formatDimensionNote,
  resizeImage,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

const IMAGE_SNIFF_BYTES = 4_100;

export function detectSupportedImageMimeType(buffer: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  const ascii = (offset: number, text: string) =>
    [...text].every((character, index) => buffer[offset + index] === character.charCodeAt(0));
  const uint16le = (offset: number) => (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
  const uint32le = (offset: number) =>
    (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) + (buffer[offset + 3] ?? 0) * 0x1000000;
  const uint32be = (offset: number) =>
    (buffer[offset] ?? 0) * 0x1000000 + ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) + (buffer[offset + 3] ?? 0);

  if (starts(0xff, 0xd8, 0xff)) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    if (buffer.length < 16 || uint32be(8) !== 13 || !ascii(12, "IHDR")) return undefined;
    let offset = 8;
    while (offset + 8 <= buffer.length) {
      const length = uint32be(offset);
      if (ascii(offset + 4, "acTL")) return undefined;
      if (ascii(offset + 4, "IDAT")) return "image/png";
      const next = offset + 12 + length;
      if (next <= offset || next > buffer.length) break;
      offset = next;
    }
    return "image/png";
  }
  if (ascii(0, "GIF")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM") && buffer.length >= 30) {
    const size = uint32le(2);
    const pixels = uint32le(10);
    const dib = uint32le(14);
    const planes = dib === 12 ? uint16le(22) : uint16le(26);
    const bits = dib === 12 ? uint16le(24) : uint16le(28);
    if ((size === 0 || size >= 26) && pixels >= 14 + dib && (size === 0 || pixels < size) &&
      (dib === 12 || (dib >= 40 && dib <= 124)) && planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits)) {
      return "image/bmp";
    }
  }
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readError(result: SandboxResult) {
  return toolResult(result);
}

function convertBmpToPng(buffer: Buffer): Buffer | undefined {
  try {
    const image = photon.PhotonImage.new_from_byteslice(buffer);
    try {
      return Buffer.from(image.get_bytes());
    } finally {
      image.free();
    }
  } catch {
    return undefined;
  }
}

export function createTools(paths: SandboxPaths, options: ToolOptions): ToolDefinition[] {
  const runner: SandboxRunner = options.runner ?? ((p, request) =>
    runSandbox(p, request, { maxOutputBytes: options.maxOutputBytes }));
  const invoke = (request: SandboxRequest) => runner(paths, { ...request, timeoutMs: request.timeoutMs ?? options.timeoutMs });

  const readTool = defineTool({
    name: "read",
    label: "Read",
    description: `Read a file visible in the sandbox. Supports text and images (jpg, png, gif, webp, bmp). Images are sent as attachments. Text is limited to ${DEFAULT_MAX_LINES} lines or the configured output byte limit. Use offset/limit to continue large files.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Path to the file (relative to /workspace or absolute inside the sandbox)" }),
      offset: Type.Optional(Type.Number({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read" })),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const imageReadLimit = 20 * 1024 * 1024;
      const result = await invoke({ executable: "/bin/cat", args: ["--", params.path], maxOutputBytes: imageReadLimit });
      if (result.exitCode !== 0 || result.timedOut) return readError(result);
      if (result.truncated) {
        return toolResult(result, `[File exceeds the ${formatSize(imageReadLimit)} image/read capture limit. Use bash for a targeted text read.]`);
      }

      const mimeType = detectSupportedImageMimeType(result.stdoutBuffer.subarray(0, IMAGE_SNIFF_BYTES));
      if (mimeType) {
        const normalizedBytes = mimeType === "image/bmp" ? convertBmpToPng(result.stdoutBuffer) : result.stdoutBuffer;
        const normalizedMimeType = mimeType === "image/bmp" ? "image/png" : mimeType;
        const processed = normalizedBytes
          ? await resizeImage(normalizedBytes, normalizedMimeType, { maxWidth: 2_000, maxHeight: 2_000 })
          : null;
        const model = (ctx as { model?: { input?: string[] } } | undefined)?.model;
        const nonVision = model && !model.input?.includes("image")
          ? "\n[Current model does not support images. The image will be omitted from this request.]"
          : "";
        if (!processed) {
          return {
            content: [{ type: "text" as const, text: `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]${nonVision}` }],
            details: { exitCode: result.exitCode, timedOut: false, truncated: false },
            isError: false,
          };
        }
        const dimensionNote = formatDimensionNote(processed);
        const conversionNote = mimeType === "image/bmp" ? "\n[Image converted from image/bmp to image/png.]" : "";
        return {
          content: [
            { type: "text" as const, text: `Read image file [${processed.mimeType}]${conversionNote}${dimensionNote ? `\n${dimensionNote}` : ""}${nonVision}` },
            { type: "image" as const, data: processed.data, mimeType: processed.mimeType },
          ],
          details: { exitCode: result.exitCode, timedOut: false, truncated: false },
          isError: false,
        };
      }

      const text = result.stdoutBuffer.toString("utf8");
      const allLines = text.split("\n");
      const start = (params.offset ?? 1) - 1;
      if (start >= allLines.length) {
        return {
          content: [{ type: "text" as const, text: `Offset ${params.offset} is beyond end of file (${allLines.length} lines total)` }],
          details: { exitCode: result.exitCode, timedOut: false, truncated: false },
          isError: true,
        };
      }
      const end = params.limit === undefined ? allLines.length : Math.min(start + params.limit, allLines.length);
      const selected = allLines.slice(start, end).join("\n");
      const truncation = truncateHead(selected, { maxLines: DEFAULT_MAX_LINES, maxBytes: options.maxOutputBytes });
      const startDisplay = start + 1;
      let output = truncation.content;
      if (truncation.firstLineExceedsLimit) {
        output = `[Line ${startDisplay} is ${formatSize(Buffer.byteLength(allLines[start] ?? "", "utf8"))}, exceeds ${formatSize(options.maxOutputBytes)} limit. Use bash for a targeted byte range.]`;
      } else if (truncation.truncated) {
        const last = startDisplay + truncation.outputLines - 1;
        output += `\n\n[Showing lines ${startDisplay}-${last} of ${allLines.length}${truncation.truncatedBy === "bytes" ? ` (${formatSize(options.maxOutputBytes)} limit)` : ""}. Use offset=${last + 1} to continue.]`;
      } else if (end < allLines.length) {
        output += `\n\n[${allLines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
      }
      return {
        content: [{ type: "text" as const, text: output }],
        details: truncation.truncated ? { truncation } : undefined,
        isError: false,
      };
    },
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
