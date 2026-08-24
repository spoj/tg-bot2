import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import multimodalExtension, { executeMultimodal, resolveMultimodalModel } from "../extensions/multimodal.js";

function fakeModel(
  provider: string,
  id: string,
  input: ("text" | "image")[] = ["text", "image"],
  api: Api = "google-generative-ai",
): Model<Api> {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api,
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
  hasConfiguredAuth?: (model: Model<Api>) => boolean;
}): { ctx: ExtensionContext; completeSpy: Mock } {
  const completeSpy = vi.fn().mockResolvedValue(
    options.completeResponse ?? fakeAssistantMessage(),
  );

  const modelRegistry = {
    find: vi.fn((provider: string, modelId: string) => {
      if (options.findModel) return options.findModel(provider, modelId);
      if (options.model?.provider === provider && options.model.id === modelId) return options.model;
      return fakeModel(provider, modelId);
    }),
    getAvailable: vi.fn(() => options.availableModels ?? [fakeModel("google", "gemini-2.5-flash")]),
    hasConfiguredAuth: vi.fn((model: Model<Api>) => options.hasConfiguredAuth?.(model) ?? true),
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
  it("resolves the exact model named by the call", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const selected = fakeModel("google-vertex", "gemini/models/flash");
      const { ctx } = fakeContext({
        cwd: tmp,
        findModel: (provider, modelId) => provider === selected.provider && modelId === selected.id ? selected : undefined,
      });
      expect(resolveMultimodalModel(ctx, "google-vertex/gemini/models/flash")).toBe(selected);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed, unknown, and unauthenticated model selections", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const { ctx } = fakeContext({ cwd: tmp, findModel: () => undefined });
      expect(() => resolveMultimodalModel(ctx, "gemini")).toThrow("provider/model");
      expect(() => resolveMultimodalModel(ctx, "google/missing")).toThrow("Model not found: google/missing");

      const { ctx: noAuth } = fakeContext({ cwd: tmp, hasConfiguredAuth: () => false });
      expect(() => resolveMultimodalModel(noAuth, "google/gemini-2.5-flash"))
        .toThrow("Model has no configured authentication: google/gemini-2.5-flash");
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
        { model: "google/gemini-2.5-flash", prompt: "Transcribe and analyze these files", files: ["test.png", "voice.oga", "doc.pdf", "note.md"] },
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
  it("routes media only through adapters with valid encodings", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      await writeFile(path.join(tmp, "image.png"), Buffer.from("fake-png-data"));
      await writeFile(path.join(tmp, "voice.oga"), Buffer.from("fake-oga-data"));
      await writeFile(path.join(tmp, "clip.mp4"), Buffer.from("fake-mp4-data"));

      const cases: Array<{
        provider: string;
        id: string;
        api: Api;
        input?: ("text" | "image")[];
        file: string;
        kind: "image" | "audio" | "video";
        supported: boolean;
      }> = [
        { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai", file: "voice.oga", kind: "audio", supported: true },
        { provider: "google-vertex", id: "gemini-2.5-flash", api: "google-vertex", file: "clip.mp4", kind: "video", supported: true },
        { provider: "openai", id: "gpt-4o", api: "openai-responses", file: "image.png", kind: "image", supported: true },
        { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", file: "image.png", kind: "image", supported: true },
        { provider: "openai", id: "gpt-4o", api: "openai-responses", file: "voice.oga", kind: "audio", supported: false },
        { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", file: "clip.mp4", kind: "video", supported: false },
        { provider: "google", id: "text-only", api: "google-generative-ai", input: ["text"], file: "voice.oga", kind: "audio", supported: false },
      ];

      for (const testCase of cases) {
        const model = fakeModel(testCase.provider, testCase.id, testCase.input, testCase.api);
        const { ctx, completeSpy } = fakeContext({ cwd: tmp, model });
        const result = await executeMultimodal(
          { model: `${testCase.provider}/${testCase.id}`, prompt: "Analyze", files: [testCase.file] },
          undefined,
          ctx,
        );

        if (!testCase.supported) {
          expect(result.content[0]?.text).toContain(`Unsupported ${testCase.kind} modality`);
          expect(completeSpy).not.toHaveBeenCalled();
          continue;
        }

        expect(result.content[0]?.text).toBe("Analysis result");
        expect(completeSpy).toHaveBeenCalledTimes(1);
        const contextArg = completeSpy.mock.calls[0]?.[1] as Context;
        const contentParts = contextArg.messages[0]?.content as Array<{ type: string; mimeType?: string }>;
        expect(contentParts[1]?.type).toBe("image");
        expect(contentParts[1]?.mimeType).toBe(
          testCase.kind === "image" ? "image/png" : testCase.kind === "audio" ? "audio/ogg" : "video/mp4",
        );
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("handles missing file cleanly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const { ctx } = fakeContext({ cwd: tmp, model: fakeModel("google", "gemini-2.5-flash") });
      const result = await executeMultimodal(
        { model: "google/gemini-2.5-flash", prompt: "Analyze", files: ["nonexistent.png"] },
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
        { model: "google/gemini-2.5-flash", prompt: "Analyze", files: ["binary.xyz123"] },
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
        { model: "google/gemini-2.5-flash", prompt: "Analyze", files: ["test.jpg"] },
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
        model: fakeModel("anthropic", "claude-3-7-sonnet", ["text", "image"], "anthropic-messages"),
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
        { model: "anthropic/claude-3-7-sonnet", prompt: "Analyze", files: ["test.pdf"] },
        undefined,
        ctx,
      );

      expect(result.content[0]?.text).toBe("PDF Analysis");
      expect(capturedPayload?.messages[0]?.content[1]?.type).toBe("document");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
  it("normalizes OpenAI Responses PDF input to a file block", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "multimodal-test-"));
    try {
      const pdfPath = path.join(tmp, "test.pdf");
      await writeFile(pdfPath, Buffer.from("fake-pdf"));

      let capturedPayload: {
        input: Array<{ content: Array<{ type: string; file_data?: string }> }>;
      } | undefined;
      const model = fakeModel("openai", "gpt-4o", ["text", "image"], "openai-responses");
      const { ctx, completeSpy } = fakeContext({ cwd: tmp, model });

      completeSpy.mockImplementation(async (_model, _context, options) => {
        const rawPayload = {
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Analyze" },
                { type: "input_image", image_url: "data:application/pdf;base64,..." },
              ],
            },
          ],
        };
        capturedPayload = options?.onPayload?.(rawPayload, model) as {
          input: Array<{ content: Array<{ type: string; file_data?: string }> }>;
        };
        return fakeAssistantMessage();
      });

      const result = await executeMultimodal(
        { model: "openai/gpt-4o", prompt: "Analyze", files: ["test.pdf"] },
        undefined,
        ctx,
      );

      expect(result.content[0]?.text).toBe("Analysis result");
      expect(capturedPayload?.input[0]?.content[1]?.type).toBe("input_file");
      expect(capturedPayload?.input[0]?.content[1]?.file_data).toBe("data:application/pdf;base64,...");
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
    expect(tool?.description).toContain("exact provider/model");
    expect((tool?.parameters as unknown as { required?: string[] }).required).toContain("model");
  });
});
