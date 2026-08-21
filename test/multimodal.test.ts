import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import multimodalExtension, { executeMultimodal, resolveMultimodalModel } from "../extensions/multimodal.js";

function fakeModel(provider: string, id: string, input: ("text" | "image")[] = ["text", "image"]): Model<Api> {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api: "google-generative-ai" as Api,
    baseUrl: "https://generativelanguage.googleapis.com",
    input,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function fakeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Analysis result" }],
    api: "google-generative-ai" as Api,
    provider: "google",
    model: "gemini-2.5-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

function fakeContext(options: {
  cwd: string;
  model?: Model<Api>;
  availableModels?: Model<Api>[];
  findModel?: (provider: string, modelId: string) => Model<Api> | undefined;
  completeResponse?: AssistantMessage;
}): { ctx: ExtensionContext; completeSpy: Mock } {
  const completeSpy = vi.fn().mockResolvedValue(
    options.completeResponse ?? fakeAssistantMessage(),
  );

  const modelRegistry = {
    find: vi.fn((provider: string, modelId: string) => {
      if (options.findModel) return options.findModel(provider, modelId);
      return fakeModel(provider, modelId);
    }),
    getAvailable: vi.fn(() => options.availableModels ?? [fakeModel("google", "gemini-2.5-flash")]),
    hasConfiguredAuth: vi.fn(() => true),
    complete: completeSpy,
  };

  const ctx = {
    cwd: options.cwd,
    mode: "print",
    hasUI: false,
    model: options.model,
    modelRegistry,
    sessionManager: {
      getCwd: () => options.cwd,
    },
  } as unknown as ExtensionContext;

  return { ctx, completeSpy };
}

describe("multimodal extension", () => {
  it("resolves model configured as string in .pi/agent/settings.json", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const piAgentDir = path.join(tmp, ".pi", "agent");
      await mkdir(piAgentDir, { recursive: true });
      await writeFile(path.join(piAgentDir, "settings.json"), JSON.stringify({
        multimodal: "anthropic/claude-3-7-sonnet",
      }));

      const { ctx } = fakeContext({ cwd: tmp });
      const model = resolveMultimodalModel(ctx);
      expect(model.provider).toBe("anthropic");
      expect(model.id).toBe("claude-3-7-sonnet");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves model configured as object in .pi/settings.json", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const piDir = path.join(tmp, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "settings.json"), JSON.stringify({
        multimodal: { provider: "google", model: "gemini-2.5-pro" },
      }));

      const { ctx } = fakeContext({ cwd: tmp });
      const model = resolveMultimodalModel(ctx);
      expect(model.provider).toBe("google");
      expect(model.id).toBe("gemini-2.5-pro");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("defaults to the session's main model if not in settings", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const mainModel = fakeModel("openai", "gpt-4o");
      const { ctx } = fakeContext({ cwd: tmp, model: mainModel });
      const model = resolveMultimodalModel(ctx);
      expect(model).toBe(mainModel);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to available vision model if main model is undefined", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const visionModel = fakeModel("google", "gemini-2.5-flash");
      const { ctx } = fakeContext({ cwd: tmp, availableModels: [visionModel] });
      const model = resolveMultimodalModel(ctx);
      expect(model).toBe(visionModel);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws if no model can be resolved", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const { ctx } = fakeContext({ cwd: tmp, availableModels: [] });
      expect(() => resolveMultimodalModel(ctx)).toThrow("No model available for multimodal analysis");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("processes images, audio, pdfs, and text files and executes model completion", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const imgPath = path.join(tmp, "test.png");
      const audioPath = path.join(tmp, "voice.oga");
      const pdfPath = path.join(tmp, "doc.pdf");
      const textPath = path.join(tmp, "note.md");

      await writeFile(imgPath, Buffer.from("fake-png-data"));
      await writeFile(audioPath, Buffer.from("fake-oga-data"));
      await writeFile(pdfPath, Buffer.from("fake-pdf-data"));
      await writeFile(textPath, "Hello world note content", "utf8");

      const { ctx, completeSpy } = fakeContext({ cwd: tmp, model: fakeModel("google", "gemini-2.5-flash") });

      const result = await executeMultimodal(
        { prompt: "Transcribe and analyze these files", files: ["test.png", "voice.oga", "doc.pdf", "note.md"] },
        undefined,
        ctx,
      );

      expect(result.content[0]?.text).toBe("Analysis result");
      expect(result.details.model).toBe("google/gemini-2.5-flash");
      expect(completeSpy).toHaveBeenCalledTimes(1);

      const [modelArg, contextArg] = completeSpy.mock.calls[0] as [Model<Api>, Context, unknown];
      expect(modelArg.id).toBe("gemini-2.5-flash");

      const userMessage = contextArg.messages[0];
      expect(userMessage?.role).toBe("user");
      const contentParts = userMessage?.content as Array<{ type: string; mimeType?: string; text?: string }>;
      expect(contentParts).toHaveLength(5);
      expect(contentParts[0]?.text).toBe("Transcribe and analyze these files");
      expect(contentParts[1]?.mimeType).toBe("image/png");
      expect(contentParts[2]?.mimeType).toBe("audio/ogg");
      expect(contentParts[3]?.mimeType).toBe("application/pdf");
      expect(contentParts[4]?.text).toContain("Hello world note content");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("handles missing file cleanly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const { ctx } = fakeContext({ cwd: tmp, model: fakeModel("google", "gemini-2.5-flash") });
      const result = await executeMultimodal(
        { prompt: "Analyze", files: ["nonexistent.png"] },
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toContain("Error: File not found: nonexistent.png");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("handles unsupported file extension cleanly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const unknownPath = path.join(tmp, "binary.xyz123");
      await writeFile(unknownPath, Buffer.from("data"));

      const { ctx } = fakeContext({ cwd: tmp, model: fakeModel("google", "gemini-2.5-flash") });
      const result = await executeMultimodal(
        { prompt: "Analyze", files: ["binary.xyz123"] },
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toContain('Error: Unsupported file format ".xyz123"');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("handles model completion error cleanly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const imgPath = path.join(tmp, "test.jpg");
      await writeFile(imgPath, Buffer.from("fake-jpg-data"));

      const { ctx } = fakeContext({
        cwd: tmp,
        model: fakeModel("google", "gemini-2.5-flash"),
        completeResponse: fakeAssistantMessage({
          stopReason: "error",
          errorMessage: "Rate limit exceeded",
          content: [],
        }),
      });

      const result = await executeMultimodal(
        { prompt: "Analyze", files: ["test.jpg"] },
        undefined,
        ctx,
      );
      expect(result.content[0]?.text).toContain("Rate limit exceeded");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes Anthropic PDF document payloads", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const pdfPath = path.join(tmp, "test.pdf");
      await writeFile(pdfPath, Buffer.from("fake-pdf"));

      let capturedPayload: { messages: Array<{ content: Array<{ type: string }> }> } | undefined;
      const { ctx, completeSpy } = fakeContext({
        cwd: tmp,
        model: fakeModel("anthropic", "claude-3-7-sonnet"),
      });

      completeSpy.mockImplementation(async (_model, _context, options) => {
        const rawPayload = {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Analyze" },
                { type: "image", source: { type: "base64", media_type: "application/pdf", data: "..." } },
              ],
            },
          ],
        };
        capturedPayload = options?.onPayload?.(rawPayload, fakeModel("anthropic", "claude-3-7-sonnet")) as { messages: Array<{ content: Array<{ type: string }> }> };
        return {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "PDF Analysis" }],
        };
      });

      const result = await executeMultimodal(
        { prompt: "Analyze", files: ["test.pdf"] },
        undefined,
        ctx,
      );

      expect(result.content[0]?.text).toBe("PDF Analysis");
      expect(capturedPayload?.messages[0]?.content[1]?.type).toBe("document");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("registers tool via extension API", () => {
    const registered: ToolDefinition[] = [];
    const fakeApi = {
      registerTool: (tool: ToolDefinition) => { registered.push(tool); },
    } as unknown as ExtensionAPI;

    multimodalExtension(fakeApi);
    expect(registered).toHaveLength(1);
    const tool = registered[0];
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("ask_multimodal");
    expect(tool?.label).toBe("Ask Multimodal");
    expect(tool?.description).toContain("Analyze and inspect images");
  });
});
