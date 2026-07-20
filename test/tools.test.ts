import { describe, expect, it } from "vitest";
import type { SandboxRequest, SandboxResult } from "../src/sandbox.js";
import { createTools } from "../src/tools.js";

const ok: SandboxResult = { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false, truncated: false };
function harness(result: SandboxResult = ok) {
  const calls: SandboxRequest[] = [];
  const tools = createTools({ workspace: "/host/workspace", sessions: "/host/sessions" }, {
    timeoutMs: 123,
    maxOutputBytes: 99,
    runner: async (_paths, request) => { calls.push(request); return result; },
  });
  return { tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])), calls };
}

async function execute(tool: any, params: unknown) {
  return tool.execute("call", params, undefined, undefined, {});
}

describe("custom tools", () => {
  it("passes read paths as direct arguments", async () => {
    const { tools, calls } = harness();
    await execute(tools.read, { path: "a; touch /bad" });
    expect(calls[0]).toMatchObject({ executable: "/bin/cat", args: ["--", "a; touch /bad"], timeoutMs: 123 });
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
    const { tools, calls } = harness({ exitCode: null, stdout: "partial", stderr: "", timedOut: true, truncated: true });
    const response = await execute(tools.bash, { command: "echo $HOME; npm i x" });
    expect(calls[0]?.args).toEqual(["-lc", "echo $HOME; npm i x"]);
    expect(response.content[0].text).toContain("tool timed out");
    expect(response.content[0].text).toContain("output truncated");
  });

  it("exposes exactly four names", () => {
    expect(createTools({ workspace: "w", sessions: "s" }, { timeoutMs: 1, maxOutputBytes: 1, runner: async () => ok }).map((x) => x.name))
      .toEqual(["read", "write", "grep", "bash"]);
  });
});
