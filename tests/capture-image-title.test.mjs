import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appAccessResponse } from "../worker/access.ts";

const root = new URL("../", import.meta.url);

test("generates a fast Quick Add title from an image without overwriting user text", async () => {
  const [page, runtime, route, environment] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("lib/capture-title.ts", root), "utf8"),
    readFile(new URL("app/api/assistant/capture-title/route.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);

  assert.match(page, /quick add image recognition started/);
  assert.match(page, /variants\.thumbnail\.blob/);
  assert.match(page, /if \(newTitleRef\.current\.trim\(\)\)/);
  assert.match(page, /updateCaptureTitle\(result\.title, "image-recognition"\)/);
  assert.match(page, /placeholder=\{recognizingCaptureTitle \? "Reading image…"/);
  assert.match(page, /imageVariantPromises/);

  assert.match(runtime, /gpt-5\.6-luna/);
  assert.match(runtime, /detail: "low"/);
  assert.match(runtime, /reasoning: \{ effort: "none" \}/);
  assert.match(runtime, /json_schema/);
  assert.match(runtime, /max_output_tokens: 100/);
  assert.match(runtime, /safety_identifier/);
  assert.match(runtime, /store: false/);
  assert.doesNotMatch(runtime, /fileName|filename/);

  assert.match(route, /MAX_CAPTURE_IMAGE_BYTES/);
  assert.match(route, /hashedSafetyIdentifier/);
  assert.match(route, /Cache-Control.*no-store/);
  assert.match(environment, /OPENAI_CAPTURE_VISION_MODEL=gpt-5\.6-luna/);
});

test("does not permit API bearer tokens to spend capture vision capacity", async () => {
  const response = await appAccessResponse(new Request("https://work.dawar.ca/api/assistant/capture-title", {
    method: "POST",
    headers: { Authorization: `Bearer dt_live_${"A".repeat(43)}` },
  }), { DB: {} });
  assert.equal(response?.status, 403);
  assert.match(await response.text(), /signed-in Dawar Todo interface/);
});

