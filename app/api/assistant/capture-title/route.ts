import { assistantUserKey } from "../../../../db/assistant";
import { generateCaptureTitle } from "../../../../lib/capture-title";
import { hashedSafetyIdentifier } from "../../../../lib/talk-runtime";

const MAX_CAPTURE_IMAGE_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const userKey = assistantUserKey(request);
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File)) {
      return Response.json({ error: "Choose an image to recognize." }, { status: 400 });
    }
    if (!image.size || image.size > MAX_CAPTURE_IMAGE_BYTES) {
      return Response.json({ error: "The recognition image must be smaller than 2 MB." }, { status: 400 });
    }
    const safetyIdentifier = await hashedSafetyIdentifier(userKey);
    const result = await generateCaptureTitle({
      bytes: await image.arrayBuffer(),
      mimeType: image.type.toLowerCase(),
      safetyIdentifier,
    });
    console.info("[todo-capture-vision-api] title generated", {
      userKey,
      model: result.model,
      inputBytes: image.size,
      outputLength: result.title.length,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(
      { title: result.title },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be recognized.";
    console.error("[todo-capture-vision-api] title generation failed", {
      userKey,
      durationMs: Date.now() - startedAt,
      error,
    });
    return Response.json(
      { error: message },
      {
        status: /configured|unavailable/i.test(message) ? 503 : 400,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  }
}

