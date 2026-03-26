const fs = require("fs");
const path = require("path");

function vllmBaseUrl() {
  const u = process.env.VLLM_BASE_URL || "http://redhataigemma-3n-e4b-it-fp8-dynamic-predictor:8080";
  return u.replace(/\/$/, "");
}

function authHeaders() {
  const key = process.env.VLLM_API_KEY;
  if (key && String(key).trim()) {
    return { Authorization: `Bearer ${key.trim()}` };
  }
  return {};
}

let cachedModelId = null;

async function resolveModelId() {
  const explicit = process.env.VLLM_MODEL?.trim();
  if (explicit) return explicit;
  if (cachedModelId) return cachedModelId;

  const res = await fetch(`${vllmBaseUrl()}/v1/models`, { headers: authHeaders() });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`vLLM GET /v1/models failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const body = await res.json();
  const id = body.data?.[0]?.id;
  if (!id) throw new Error("vLLM /v1/models returned no models");
  cachedModelId = id;
  return id;
}

/** Map file extension to vLLM/OpenAI input_audio format hint (librosa-backed on server). */
function audioFormatFromFilename(filename) {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  const map = {
    webm: "webm",
    wav: "wav",
    mp3: "mp3",
    m4a: "mp4",
    mp4: "mp4",
    ogg: "ogg",
    opus: "opus",
    flac: "flac",
  };
  return map[ext] || ext || "webm";
}

function extractAssistantText(message) {
  const c = message?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && (p.type === "text" || p.text))
      .map((p) => p.text || "")
      .join("")
      .trim();
  }
  return "";
}

/**
 * Sends audio to vLLM OpenAI-compatible chat completions (input_audio base64).
 * @param {string} filePath absolute path to audio file on disk
 * @param {string} originalFilename original name (for format hint)
 * @returns {Promise<string>} transcript text
 */
async function transcribeFile(filePath, originalFilename) {
  const buf = await fs.promises.readFile(filePath);
  const b64 = buf.toString("base64");
  const format = audioFormatFromFilename(originalFilename);
  const model = await resolveModelId();

  const maxTokens = parseInt(process.env.VLLM_MAX_TOKENS || "4096", 10);
  const timeoutMs = parseInt(process.env.VLLM_REQUEST_TIMEOUT_MS || "120000", 10);

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              process.env.VLLM_TRANSCRIBE_PROMPT ||
              "Transcribe the speech in this audio to plain text. Output only the transcript, same language as the speaker, with no preamble or explanation.",
          },
          {
            type: "input_audio",
            input_audio: {
              data: b64,
              format,
            },
          },
        ],
      },
    ],
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${vllmBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`vLLM response not JSON (${res.status}): ${raw.slice(0, 300)}`);
  }

  if (!res.ok) {
    const err = json.error?.message || json.message || raw.slice(0, 400);
    throw new Error(`vLLM chat/completions ${res.status}: ${err}`);
  }

  const choice = json.choices?.[0];
  const text = extractAssistantText(choice?.message);
  if (!text) {
    throw new Error("vLLM returned empty assistant content");
  }
  return text;
}

module.exports = {
  transcribeFile,
  vllmBaseUrl,
  resolveModelId,
  audioFormatFromFilename,
};
