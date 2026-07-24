import { env } from "cloudflare:workers";

type RuntimeEnvironment = {
  OPENAI_API_KEY?: string;
  OPENAI_CAPTURE_VISION_MODEL?: string;
};

type OpenAIResponse = {
  id?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
};

const DEFAULT_CAPTURE_VISION_MODEL = "gpt-5.6-luna";
const MAX_CAPTURE_IMAGE_BYTES = 2 * 1024 * 1024;
const supportedCaptureMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function runtime() {
  return env as unknown as RuntimeEnvironment;
}

function responseText(response: OpenAIResponse) {
  if (response.output_text?.trim()) return response.output_text.trim();
  return response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && item.text)
    .map((item) => item.text)
    .join("")
    .trim() ?? "";
}

export function normalizeCaptureTitle(value: unknown) {
  if (typeof value !== "string") return "";
  const title = value
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (title.length <= 100) return title;
  return `${title.slice(0, 97).trimEnd()}…`;
}

export async function generateCaptureTitle(input: {
  bytes: ArrayBuffer;
  mimeType: string;
  safetyIdentifier: string;
}) {
  const configuration = runtime();
  const apiKey = configuration.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Automatic image titles are not configured.");
  if (!supportedCaptureMimeTypes.has(input.mimeType)) throw new Error("That image format cannot be recognized.");
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_CAPTURE_IMAGE_BYTES) {
    throw new Error("The recognition image is too large.");
  }

  const model = configuration.OPENAI_CAPTURE_VISION_MODEL?.trim() || DEFAULT_CAPTURE_VISION_MODEL;
  const startedAt = Date.now();
  const encoded = Buffer.from(input.bytes).toString("base64");
  console.info("[todo-capture-vision] recognition starting", {
    model,
    mimeType: input.mimeType,
    inputBytes: input.bytes.byteLength,
  });
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        "Generate a short, useful todo title from the image.",
        "Infer the likely action the user wants to remember, especially from screenshots, documents, products, messages, receipts, or visible text.",
        "Use a concise action-oriented phrase. Do not explain, mention the image, add quotation marks, or end with punctuation.",
        "Prefer a specific title over a generic one. If no concrete action is inferable, use a short review or follow-up task.",
      ].join(" "),
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Create the shortest useful task title for this attachment." },
          {
            type: "input_image",
            image_url: `data:${input.mimeType};base64,${encoded}`,
            detail: "low",
          },
        ],
      }],
      reasoning: { effort: "none" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "quick_add_task_title",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: {
              title: { type: "string", minLength: 1, maxLength: 100 },
            },
          },
        },
      },
      max_output_tokens: 100,
      safety_identifier: input.safetyIdentifier,
      store: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as OpenAIResponse;
  if (!response.ok) {
    console.error("[todo-capture-vision] recognition failed", {
      model,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorType: body.error ? "openai-error" : "unexpected-response",
    });
    throw new Error(body.error?.message || "The image could not be recognized.");
  }

  let parsed: { title?: unknown };
  try {
    parsed = JSON.parse(responseText(body)) as { title?: unknown };
  } catch {
    console.error("[todo-capture-vision] structured response parse failed", {
      model,
      responseId: body.id ?? null,
      durationMs: Date.now() - startedAt,
    });
    throw new Error("The image recognition response was invalid.");
  }
  const title = normalizeCaptureTitle(parsed.title);
  if (!title) throw new Error("No useful title was found.");
  console.info("[todo-capture-vision] recognition completed", {
    model,
    responseId: body.id ?? null,
    inputBytes: input.bytes.byteLength,
    outputLength: title.length,
    durationMs: Date.now() - startedAt,
  });
  return { title, model };
}

