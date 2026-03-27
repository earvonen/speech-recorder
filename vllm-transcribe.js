const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Agent } = require("undici");

function tlsInsecureEnabled() {
  const v = process.env.VLLM_TLS_INSECURE;
  return v === "1" || v === "true" || String(v).toLowerCase() === "yes";
}

/** Undici fetch ignores NODE_TLS_REJECT_UNAUTHORIZED; use a dispatcher with rejectUnauthorized: false. */
let vllmInsecureAgent = null;
function vllmFetchInit(init = {}) {
  if (!tlsInsecureEnabled()) return init;
  if (!vllmInsecureAgent) {
    vllmInsecureAgent = new Agent({
      connect: {
        rejectUnauthorized: false,
      },
    });
  }
  return { ...init, dispatcher: vllmInsecureAgent };
}

/**
 * vLLM decodes input_audio with librosa → soundfile, which does not support WebM/Opus from the browser.
 * Decode with ffmpeg to 16 kHz mono PCM WAV (matches Gemma 3n audio guidance).
 */
async function convertToPcmWav16kMono(inputPath) {
  const tmp = path.join(os.tmpdir(), `sr-wav-${crypto.randomBytes(12).toString("hex")}.wav`);
  const timeoutMs = parseInt(process.env.FFMPEG_TIMEOUT_MS || "300000", 10);

  try {
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        tmp,
      ],
      timeoutMs > 0 ? { timeout: timeoutMs } : {}
    );

    if (result.error) {
      if (result.error.code === "ENOENT") {
        throw new Error(
          "ffmpeg is not installed or not on PATH. It is required to convert WebM/Opus to WAV for vLLM."
        );
      }
      throw result.error;
    }

    if (result.status !== 0) {
      const err = (result.stderr && result.stderr.toString()) || `exit ${result.status}`;
      throw new Error(`ffmpeg failed: ${err.slice(0, 600)}`);
    }

    return await fs.promises.readFile(tmp);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

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

  const res = await fetch(`${vllmBaseUrl()}/v1/models`, vllmFetchInit({ headers: authHeaders() }));
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

/**
 * Collect human-readable text from OpenAI-style message.content (string, array, or nested).
 * vLLM / Gemma may use part shapes that omit type === "text" or use other field names.
 */
function flattenContentParts(parts) {
  if (parts == null) return "";
  if (typeof parts === "string") return parts;
  if (typeof parts === "number" || typeof parts === "boolean") return String(parts);
  if (!Array.isArray(parts)) {
    if (typeof parts === "object") {
      return flattenContentParts([parts]);
    }
    return "";
  }
  const chunks = [];
  for (const p of parts) {
    if (p == null) continue;
    if (typeof p === "string") {
      chunks.push(p);
      continue;
    }
    if (typeof p !== "object") continue;
    if (typeof p.text === "string") chunks.push(p.text);
    if (typeof p.content === "string") chunks.push(p.content);
    else if (Array.isArray(p.content)) chunks.push(flattenContentParts(p.content));
    if (typeof p.output_text === "string") chunks.push(p.output_text);
    if (typeof p.value === "string") chunks.push(p.value);
  }
  return chunks.join("");
}

function extractAssistantText(message) {
  if (!message) return "";

  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }

  if (message.parts && Array.isArray(message.parts)) {
    const fromParts = flattenContentParts(message.parts).trim();
    if (fromParts) return fromParts;
  }

  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (c != null && typeof c === "object") {
    if (!Array.isArray(c) && Array.isArray(c.parts)) {
      const fromNested = flattenContentParts(c.parts).trim();
      if (fromNested) return fromNested;
    }
    const flat = flattenContentParts(Array.isArray(c) ? c : [c]).trim();
    if (flat) return flat;
  }

  if (typeof message.refusal === "string" && message.refusal.trim()) {
    return message.refusal.trim();
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  return "";
}

/** Best-effort text from one chat completion choice (message, legacy text, delta). */
function extractTextFromChoice(choice) {
  if (!choice) return "";
  let t = extractAssistantText(choice.message);
  if (t) return t;
  if (typeof choice.text === "string" && choice.text.trim()) {
    return choice.text.trim();
  }
  const delta = choice.delta;
  if (delta) {
    t = extractAssistantText({ content: delta.content, refusal: delta.refusal });
    if (t) return t;
    if (typeof delta.content === "string" && delta.content.trim()) {
      return delta.content.trim();
    }
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
  const skipFfmpeg =
    process.env.VLLM_SKIP_FFMPEG === "1" || process.env.VLLM_SKIP_FFMPEG === "true";
  let buf;
  let format;
  if (skipFfmpeg) {
    buf = await fs.promises.readFile(filePath);
    const ext = path.extname(originalFilename).replace(/^\./, "").toLowerCase();
    format = ext === "wav" ? "wav" : ext || "wav";
  } else {
    buf = await convertToPcmWav16kMono(filePath);
    format = "wav";
  }

  const b64 = buf.toString("base64");
  const model = await resolveModelId();

  const maxTokens = parseInt(process.env.VLLM_MAX_TOKENS || "4096", 10);
  // Long audio + large models often exceed 2 minutes; default 15m unless overridden.
  const timeoutMs = parseInt(process.env.VLLM_REQUEST_TIMEOUT_MS || "900000", 10);

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
    res = await fetch(
      `${vllmBaseUrl()}/v1/chat/completions`,
      vllmFetchInit({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    );
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

  const choices = Array.isArray(json.choices) ? json.choices : [];
  let text = "";
  for (const ch of choices) {
    text = extractTextFromChoice(ch);
    if (text) break;
  }

  if (!text) {
    const dbg =
      process.env.VLLM_DEBUG_RESPONSE === "1" || process.env.VLLM_DEBUG_RESPONSE === "true";
    const first = choices[0];
    const hint = first
      ? JSON.stringify({
          finish_reason: first.finish_reason,
          message: first.message,
          text: first.text,
          delta: first.delta,
        }).slice(0, 2000)
      : "(no choices)";
    if (dbg) {
      console.error("[vLLM raw chat/completions body]", raw.slice(0, 8000));
    }
    throw new Error(
      `vLLM returned empty assistant content (finish_reason=${first?.finish_reason ?? "n/a"}). ` +
        `Set VLLM_DEBUG_RESPONSE=1 for full body log. Parsed choice snippet: ${hint}`
    );
  }

  return text;
}

module.exports = {
  transcribeFile,
  vllmBaseUrl,
  resolveModelId,
  convertToPcmWav16kMono,
};
