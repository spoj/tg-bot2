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

type MediaKind = "image" | "audio" | "video" | "pdf";
type MediaInfo = { mime: string; kind: MediaKind };

const MIME_MAP: Record<string, MediaInfo> = {
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

function isAnthropicAdapter(model: Model<Api>): boolean {
  return model.provider === "anthropic" || model.api === "anthropic-messages";
}

function isOpenAIAdapter(model: Model<Api>): boolean {
  return model.provider === "openai" ||
    model.provider === "openai-codex" ||
    model.provider === "azure-openai-responses" ||
    model.api === "openai-completions" ||
    model.api === "openai-responses" ||
    model.api === "openai-codex-responses" ||
    model.api === "azure-openai-responses";
}

function isOpenAIResponsesAdapter(model: Model<Api>): boolean {
  return model.api === "openai-responses" ||
    model.api === "openai-codex-responses" ||
    model.api === "azure-openai-responses";
}

/**
 * pi-ai's chat content union has only ImageContent for binary input. The
 * Google adapters translate that block to inlineData, whose MIME field also
 * supports audio, video, and PDF. Other installed adapters translate it to an
 * image-specific wire block, so those modalities need an explicit route.
 */
function isGoogleAdapter(model: Model<Api>): boolean {
  if (isAnthropicAdapter(model) || isOpenAIAdapter(model)) return false;
  return model.api === "google-generative-ai" || model.api === "google-vertex";
}

function supportsMedia(model: Model<Api>, media: MediaInfo): boolean {
  if (!model.input.includes("image")) return false;

  switch (media.kind) {
    case "image":
      return true;
    case "pdf":
      return isGoogleAdapter(model) || isAnthropicAdapter(model) || isOpenAIResponsesAdapter(model);
    case "audio":
    case "video":
      return isGoogleAdapter(model);
  }
}

function unsupportedMediaMessage(model: Model<Api>, media: Pick<MediaInfo, "kind" | "mime">): string {
  const modelName = `${model.provider}/${model.id}`;
  if (!model.input.includes("image")) {
    return `Error: Unsupported ${media.kind} modality for ${modelName}: model metadata does not advertise binary media input.`;
  }
  return `Error: Unsupported ${media.kind} modality for ${modelName}: the installed ${model.api} adapter has no valid ${media.kind} input encoding for ${media.mime}; it cannot be sent as an image.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function dataUrlMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^data:([^;,]+)[;,]/i.exec(value)?.[1]?.toLowerCase();
}

function mediaKindForMime(mime: string): MediaKind | undefined {
  const normalized = mime.toLowerCase();
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return undefined;
}

function findUnsupportedImageMime(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const mime = findUnsupportedImageMime(item);
      if (mime !== undefined) return mime;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (record === undefined) return undefined;

  let mime: string | undefined;
  if (record.type === "image" && typeof record.mimeType === "string") {
    mime = record.mimeType;
  } else if (record.type === "image" && asRecord(record.source)?.media_type !== undefined) {
    const source = asRecord(record.source);
    if (typeof source?.media_type === "string") mime = source.media_type;
  } else if (record.type === "image_url") {
    const imageUrl = asRecord(record.image_url);
    mime = dataUrlMimeType(typeof record.image_url === "string" ? record.image_url : imageUrl?.url);
  } else if (record.type === "input_image") {
    const imageUrl = asRecord(record.image_url);
    mime = dataUrlMimeType(typeof record.image_url === "string" ? record.image_url : imageUrl?.url);
  }

  if (mime !== undefined && mediaKindForMime(mime) !== undefined) return mime;
  for (const nested of Object.values(record)) {
    const nestedMime = findUnsupportedImageMime(nested);
    if (nestedMime !== undefined) return nestedMime;
  }
  return undefined;
}

function normalizeAnthropicPdfPayload(payload: unknown, model: Model<Api>): unknown {
  if (!isAnthropicAdapter(model)) return payload;
  const body = asRecord(payload);
  const messages = body?.messages;
  if (!Array.isArray(messages)) return payload;

  for (const messageValue of messages) {
    const message = asRecord(messageValue);
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const blockValue of content) {
      const block = asRecord(blockValue);
      const source = asRecord(block?.source);
      if (block?.type === "image" && source?.media_type === "application/pdf") {
        block.type = "document";
      }
    }
  }
  return payload;
}

function normalizeOpenAIPdfPayload(payload: unknown, model: Model<Api>): unknown {
  if (!isOpenAIResponsesAdapter(model)) return payload;
  const body = asRecord(payload);
  const input = body?.input;
  if (!Array.isArray(input)) return payload;

  for (const itemValue of input) {
    const item = asRecord(itemValue);
    if (item === undefined || !Array.isArray(item.content)) continue;
    const content = item.content;
    item.content = content.map((partValue) => {
      const part = asRecord(partValue);
      if (part?.type !== "input_image") return partValue;
      const imageUrl = asRecord(part.image_url);
      const dataUrl = typeof part.image_url === "string" ? part.image_url : imageUrl?.url;
      if (dataUrlMimeType(dataUrl) !== "application/pdf") return partValue;
      return { type: "input_file", file_data: dataUrl };
    });
  }
  return payload;
}

function normalizePayload(payload: unknown, model: Model<Api>): unknown {
  const normalizedAnthropic = normalizeAnthropicPdfPayload(payload, model);
  const normalized = normalizeOpenAIPdfPayload(normalizedAnthropic, model);
  if (!isGoogleAdapter(model)) {
    const mime = findUnsupportedImageMime(normalized);
    const kind = mime === undefined ? undefined : mediaKindForMime(mime);
    if (mime !== undefined && kind !== undefined) {
      throw new Error(unsupportedMediaMessage(model, { kind, mime }).slice("Error: ".length));
    }
  }
  return normalized;
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
        if (!supportsMedia(model, media)) {
          return text(unsupportedMediaMessage(model, media));
        }
        const data = readFileSync(filePath).toString("base64");
        parts.push({
          // ImageContent is pi-ai's only binary chat content type. Google
          // adapters turn this into inlineData; unsupported adapters are
          // rejected above instead of receiving an image block with a wrong MIME.
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
      onPayload: (payload: unknown, m: Model<Api>): unknown => normalizePayload(payload, m),
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
