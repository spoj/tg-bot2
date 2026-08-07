import { describe, expect, it } from "vitest";
import type { SandboxRequest, SandboxResult } from "../src/sandbox.js";
import { createTools, detectSupportedImageMimeType, type ToolHandlers } from "../src/tools.js";

const ok: SandboxResult = { exitCode: 0, stdout: "ok\n", stdoutBuffer: Buffer.from("ok\n"), stderr: "", timedOut: false, truncated: false };
function harness(result: SandboxResult = ok, extra: { handlers?: ToolHandlers; chatId?: number } = {}) {
  const calls: SandboxRequest[] = [];
  const tools = createTools({ workspace: "/host/workspace", sessions: "/host/sessions" }, {
    timeoutMs: 123,
    maxOutputBytes: 99,
    runner: async (_paths, request) => { calls.push(request); return result; },
    ...extra,
  });
  return { tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])), calls };
}

async function execute(tool: any, params: unknown) {
  return tool.execute("call", params, undefined, undefined, {});
}

describe("custom tools", () => {
  it("passes read paths as direct arguments and supports text ranges", async () => {
    const text = "one\ntwo\nthree\nfour";
    const { tools, calls } = harness({ ...ok, stdout: text, stdoutBuffer: Buffer.from(text) });
    const response = await execute(tools.read, { path: "a; touch /bad", offset: 2, limit: 2 });
    expect(calls[0]).toMatchObject({
      executable: "/bin/cat",
      args: ["--", "a; touch /bad"],
      timeoutMs: 123,
      maxOutputBytes: 20 * 1024 * 1024,
    });
    expect(response.content[0].text).toBe("two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]");
  });

  it("truncates text at Pi's 2000-line default with a continuation offset", async () => {
    const text = Array.from({ length: 2_001 }, (_, index) => `line-${index + 1}`).join("\n");
    const calls: SandboxRequest[] = [];
    const [read] = createTools({ workspace: "/host/workspace", sessions: "/host/sessions" }, {
      timeoutMs: 123,
      maxOutputBytes: 50_000,
      runner: async (_paths, request) => {
        calls.push(request);
        return { ...ok, stdout: text, stdoutBuffer: Buffer.from(text) };
      },
    });
    const response = await execute(read, { path: "large.txt" });
    expect(response.isError).toBe(false);
    expect(response.content[0].text).toContain("[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]");
    expect(response.details.truncation.truncatedBy).toBe("lines");
  });

  it("returns a clear error for a text offset beyond EOF", async () => {
    const text = "one\ntwo";
    const { tools } = harness({ ...ok, stdout: text, stdoutBuffer: Buffer.from(text) });
    const response = await execute(tools.read, { path: "file", offset: 9 });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("beyond end of file (2 lines total)");
  });

  it("matches Pi image signature acceptance for common formats and exclusions", () => {
    expect(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xf7]))).toBeUndefined();
    expect(detectSupportedImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectSupportedImageMimeType(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
  });

  it("returns supported images as Pi image content without UTF-8 corruption", async () => {
    // 1x1 transparent PNG. Binary bytes deliberately include invalid UTF-8.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const { tools } = harness({ ...ok, stdout: png.toString("utf8"), stdoutBuffer: png });
    const response = await execute(tools.read, { path: "pixel.png" });
    expect(response.isError).toBe(false);
    expect(response.content[0]).toMatchObject({ type: "text" });
    expect(response.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(response.content[1].data, "base64").subarray(0, 8)).toEqual(png.subarray(0, 8));
  });

  it("converts BMP images to a provider-compatible inline format", async () => {
    // Minimal 1x1, 24-bit BMP with one padded pixel row.
    const bmp = Buffer.alloc(58);
    bmp.write("BM");
    bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(4, 34); bmp.set([0, 0, 255, 0], 54);
    const { tools } = harness({ ...ok, stdout: bmp.toString("utf8"), stdoutBuffer: bmp });
    const response = await execute(tools.read, { path: "pixel.bmp" });
    expect(response.content[0].text).toContain("converted from image/bmp to image/png");
    expect(response.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("rejects truncated binary reads instead of returning a corrupt image", async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { tools } = harness({ ...ok, stdout: pngHeader.toString("utf8"), stdoutBuffer: pngHeader, truncated: true });
    const response = await execute(tools.read, { path: "huge.png" });
    expect(response.isError).toBe(false);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].text).toContain("20.0MB image/read capture limit");
  });

  it("passes write content via stdin and path positionally", async () => {
    const { tools, calls } = harness();
    await execute(tools.write, { path: "dir/file", content: "$(bad)\nsecret" });
    expect(calls[0]?.stdin).toEqual(Buffer.from("$(bad)\nsecret"));
    expect(calls[0]?.args.at(-1)).toBe("dir/file");
    expect(calls[0]?.args.join(" ")).not.toContain("secret");
  });

  it("uses fixed-string grep and treats exit 1 as no matches", async () => {
    const { tools, calls } = harness({ ...ok, exitCode: 1, stdout: "" });
    const response = await execute(tools.grep, { query: "a.*", path: "/workspace/sessions_ro" });
    expect(calls[0]?.args).toEqual(["-F", "-i", "-n", "--with-filename", "--", "a.*", "/workspace/sessions_ro"]);
    expect(response.isError).toBe(false);
    expect(response.content[0].text).toBe("No matches.");
  });

  it("passes the exact model command to inner bash and renders limits", async () => {
    const { tools, calls } = harness({ exitCode: null, stdout: "partial", stdoutBuffer: Buffer.from("partial"), stderr: "", timedOut: true, truncated: true });
    const response = await execute(tools.bash, { command: "echo $HOME; npm i x" });
    expect(calls[0]?.args).toEqual(["-lc", "echo $HOME; npm i x"]);
    expect(response.content[0].text).toContain("tool timed out");
    expect(response.content[0].text).toContain("output truncated");
  });

  it("conditionally exposes trusted domain handlers and binds every call to chatId", async () => {
    const received: unknown[] = [];
    const handlers: ToolHandlers = {
      sendFile: async (chatId, sandboxPath, caption) => { received.push(["file", chatId, sandboxPath, caption]); return "sent"; },
      schedule: async (chatId, request) => { received.push(["schedule", chatId, request]); return "scheduled"; },
      listSchedules: async (chatId) => { received.push(["list", chatId]); return "listed"; },
      cancelSchedule: async (chatId, id) => { received.push(["cancel", chatId, id]); return "cancelled"; },
    };
    const { tools } = harness(ok, { handlers, chatId: 42 });
    expect(Object.keys(tools)).toEqual(["read", "write", "grep", "bash", "send_file", "schedule", "list_schedules", "cancel_schedule", "web_search"]);
    await execute(tools.send_file, { path: "../outside", caption: "report" });
    await execute(tools.schedule, { when: "2030-01-01T00:00:00Z", prompt: "check", recurring: "daily" });
    await execute(tools.list_schedules, {});
    await execute(tools.cancel_schedule, { id: "abc" });
    expect(received).toEqual([
      ["file", 42, "../outside", "report"],
      ["schedule", 42, { when: "2030-01-01T00:00:00Z", prompt: "check", recurring: "daily" }],
      ["list", 42],
      ["cancel", 42, "abc"],
    ]);
  });

  it("omits domain handlers without their callback or trusted chat binding", () => {
    const callbacks: ToolHandlers = { sendFile: async () => "sent", listSchedules: async () => "listed" };
    expect(createTools({ workspace: "w", sessions: "s" }, { timeoutMs: 1, maxOutputBytes: 1, handlers: callbacks, runner: async () => ok }).map((x) => x.name))
      .toEqual(["read", "write", "grep", "bash", "web_search"]);
    expect(createTools({ workspace: "w", sessions: "s" }, { timeoutMs: 1, maxOutputBytes: 1, handlers: callbacks, chatId: 7, runner: async () => ok }).map((x) => x.name))
      .toEqual(["read", "write", "grep", "bash", "send_file", "list_schedules", "web_search"]);
  });

  it("searches through curl argv and formats abstract and nested related results", async () => {
    const body = JSON.stringify({
      Heading: "Red Fox",
      AbstractText: "A fox is a mammal.",
      AbstractURL: "https://example.test/fox",
      RelatedTopics: [{ Text: "Fox facts", FirstURL: "https://example.test/facts" }, { Topics: [{ Text: "Fox habitat", FirstURL: "https://example.test/habitat" }] }],
    });
    const { tools, calls } = harness({ ...ok, stdout: body, stdoutBuffer: Buffer.from(body) });
    const response = await execute(tools.web_search, { query: "red fox & habitat" });
    const request = calls[0];
    expect(request?.executable).toBe("/usr/bin/curl");
    expect(request?.args).not.toContain("-c");
    expect(request?.args).not.toContain("-lc");
    expect(request?.args.at(-1)).toContain("q=red%20fox%20%26%20habitat");
    expect(request?.maxOutputBytes).toBe(99);
    expect(response.content[0].text).toContain("Abstract: A fox is a mammal.");
    expect(response.content[0].text).toContain("Fox facts (https://example.test/facts)");
    expect(response.content[0].text).toContain("Fox habitat (https://example.test/habitat)");
  });

  it("reports no-result searches and bounded curl failures as tool results", async () => {
    const empty = JSON.stringify({ Heading: "", AbstractText: "", RelatedTopics: [] });
    const noResult = await execute(harness({ ...ok, stdout: empty, stdoutBuffer: Buffer.from(empty) }).tools.web_search, { query: "nothing" });
    expect(noResult.isError).toBe(false);
    expect(noResult.content[0].text).toContain("No results found");

    const timedOut = await execute(harness({ ...ok, exitCode: null, stdout: "partial", stdoutBuffer: Buffer.from("partial"), timedOut: true }).tools.web_search, { query: "slow" });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.content[0].text).toContain("tool timed out");
    const failed = await execute(harness({ ...ok, exitCode: 22, stderr: "bad gateway" }).tools.web_search, { query: "failed" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("bad gateway");
    const truncated = await execute(harness({ ...ok, truncated: true }).tools.web_search, { query: "large" });
    expect(truncated.isError).toBe(true);
    expect(truncated.content[0].text).toContain("output truncated");
  });

  it("exposes the base tools and web search by default", () => {
    expect(createTools({ workspace: "w", sessions: "s" }, { timeoutMs: 1, maxOutputBytes: 1, runner: async () => ok }).map((x) => x.name))
      .toEqual(["read", "write", "grep", "bash", "web_search"]);
  });
});
