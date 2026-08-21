import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

const MULTIMODAL_SCHEMA = Type.Object({
  prompt: Type.String({ description: "Question, transcription request, or analysis prompt for the multimodal model" }),
  files: Type.Array(Type.String(), { description: "Workspace file paths to inspect (images, audio notes, video, PDFs, text)" }),
});

const MIME_MAP: Record<string, { mime: string; kind: "image" | "audio" | "video" | "pdf" }> = {
  // Images
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  // Documents
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  // Audio
  ".oga": { mime: "audio/ogg", kind: "audio" },
  ".ogg": { mime: "audio/ogg", kind: "audio" },
  ".opus": { mime: "audio/opus", kind: "audio" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".wav": { mime: "audio/wav", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".aac": { mime: "audio/aac", kind: "audio" },
  // Video
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
};

const TEXT_EXTS = new Set([
  ".txt", ".md", ".json", ".jsonl", ".csv", ".ts", ".js", ".py", ".rs", ".sh",
  ".html", ".xml", ".yaml", ".yml", ".toml", ".sql", ".css", ".log", ".env",
]);

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function text(content: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: content }], details };
}

function readSettings(cwd: string): Record<string, unknown> {
  const candidates = [
    process.env.PI_CODING_AGENT_DIR ? path.join(process.env.PI_CODING_AGENT_DIR, "settings.json") : undefined,
    path.join(cwd, ".pi", "agent", "settings.json"),
    path.join(cwd, ".pi", "settings.json"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8"));
      } catch {
        // Ignore malformed settings
      }
    }
  }
  return {};
}

export function resolveMultimodalModel(ctx: ExtensionContext): Model<Api> {
  const settings = readSettings(ctx.cwd);
  const configured = settings.multimodal ?? settings.multimodalModel;

  if (typeof configured === "string") {
    const [provider, ...rest] = configured.split("/");
    const modelId = rest.join("/");
    if (provider && modelId) {
      const found = ctx.modelRegistry.find(provider, modelId);
      if (found) return found;
    }
  } else if (typeof configured === "object" && configured !== null) {
    const conf = configured as Record<string, unknown>;
    if (typeof conf.provider === "string" && typeof conf.model === "string") {
      const found = ctx.modelRegistry.find(conf.provider, conf.model);
      if (found) return found;
    }
  }

  // If not in settings, default to the main model of the session
  if (ctx.model) {
    return ctx.model;
  }

  // Fallback: pick any available model supporting image input
  const available = ctx.modelRegistry.getAvailable();
  const visionModel = available.find((m) => m.input?.includes("image") && ctx.modelRegistry.hasConfiguredAuth(m));
  if (visionModel) {
    return visionModel;
  }

  throw new Error("No model available for multimodal analysis. Please configure a model in settings or auth.");
}

export async function executeMultimodal(
  params: { prompt: string; files: string[] },
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult> {
  try {
    const model = resolveMultimodalModel(ctx);
    const parts: Array<TextContent | ImageContent> = [
      { type: "text", text: params.prompt },
    ];

    for (const rawPath of params.files) {
      const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath);
      if (!existsSync(filePath)) {
        return text(`Error: File not found: ${rawPath}`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const media = MIME_MAP[ext];

      if (media !== undefined) {
        const data = readFileSync(filePath).toString("base64");
        parts.push({
          type: "image",
          data,
          mimeType: media.mime,
        });
      } else if (TEXT_EXTS.has(ext)) {
        const textContent = readFileSync(filePath, "utf8");
        parts.push({
          type: "text",
          text: `\n--- File: ${path.basename(filePath)} ---\n${textContent}\n--- End File ---\n`,
        });
      } else {
        return text(`Error: Unsupported file format "${ext}". Supported formats include images, audio, video, PDFs, and text/code documents.`);
      }
    }

    const completionContext: Context = {
      systemPrompt: "You are an expert multimodal assistant. Accurately analyze, transcribe, or extract information from the provided media and text according to the user instructions.",
      messages: [{ role: "user", content: parts, timestamp: Date.now() }],
    };

    const options = {
      ...(signal !== undefined ? { signal } : {}),
      onPayload: (payload: unknown, m: Model<Api>): unknown => {
        if (m.provider === "anthropic" && typeof payload === "object" && payload !== null) {
          const body = payload as { messages?: Array<{ content?: Array<{ type?: string; source?: { media_type?: string } }> }> };
          if (Array.isArray(body.messages)) {
            for (const msg of body.messages) {
              if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === "image" && block.source?.media_type === "application/pdf") {
                    block.type = "document";
                  }
                }
              }
            }
          }
        }
        return payload;
      },
    };

    const response = await ctx.modelRegistry.complete(model, completionContext, options);

    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Model completion returned an error");
    }

    const resultText = response.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    return text(resultText, { model: `${model.provider}/${model.id}` });
  } catch (error) {
    return text(`Multimodal analysis failed: ${String(error)}`);
  }
}

export default function multimodalExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_multimodal",
    label: "Ask Multimodal",
    description: "Analyze and inspect images, audio recordings (.oga, .ogg, .mp3, .wav), videos (.mp4), PDFs, and documents using multimodal models.",
    promptSnippet: "ask_multimodal: Inspect images, audio, video, and PDFs with multimodal models",
    parameters: MULTIMODAL_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeMultimodal(params as { prompt: string; files: string[] }, signal, ctx);
    },
  });
}
