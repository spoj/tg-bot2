import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

const MULTIMODAL_SCHEMA = Type.Object({
  model: Type.String({ description: "Exact provider/model ID to use for this call" }),
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


export function resolveMultimodalModel(ctx: ExtensionContext, spec: string): Model<Api> {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error("model must use provider/model format");
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Model not found: ${spec}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model has no configured authentication: ${spec}`);
  return model;
}

export async function executeMultimodal(
  params: { model: string; prompt: string; files: string[] },
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult> {
  try {
    const model = resolveMultimodalModel(ctx, params.model);
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
    description: "Analyze files with the exact provider/model selected in each call. Always set model explicitly.",
    promptSnippet: "ask_multimodal: inspect files with an explicit provider/model",
    parameters: MULTIMODAL_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeMultimodal(params as { model: string; prompt: string; files: string[] }, signal, ctx);
    },
  });
}
