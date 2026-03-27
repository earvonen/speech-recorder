// vLLM HTTPS + self-signed certs: set VLLM_TLS_INSECURE=true (handled in vllm-transcribe.js via undici Agent).

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { transcribeFile } = require("./vllm-transcribe");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

/** @param {unknown} raw */
function uploadsBasename(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > 255) return null;
  if (t.includes("..") || t.includes("/") || t.includes("\\")) return null;
  const base = path.basename(t);
  if (base !== t) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return null;
  return base;
}

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, "") || "recording";
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "512kb" }));

const MAX_MANUAL_TEXT_CHARS = 256 * 1024;

/** Same outcome as a successful STT transcript: UTF-8 .txt in uploads/, same JSON shape for clients. */
app.post("/api/submit-text", async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string") {
    return res.status(400).json({ error: 'Expected JSON body { "text": string }' });
  }
  if (text.length > MAX_MANUAL_TEXT_CHARS) {
    return res.status(400).json({ error: `Text exceeds ${MAX_MANUAL_TEXT_CHARS} characters` });
  }

  const transcriptFilename = `manual-${Date.now()}.txt`;
  const transcriptPath = path.join(UPLOAD_DIR, transcriptFilename);

  try {
    await fs.promises.writeFile(transcriptPath, text, "utf8");
    res.json({
      ok: true,
      transcriptFilename,
      transcriptPath,
      transcriptionText: text,
    });
  } catch (err) {
    console.error("[submit-text]", err);
    res.status(500).json({ error: err.message || "Failed to save file" });
  }
});

app.post("/api/transcribe", async (req, res) => {
  const name = uploadsBasename(req.body?.filename);
  if (!name) {
    return res.status(400).json({ error: "Invalid or missing filename" });
  }

  const skip = process.env.VLLM_DISABLE_TRANSCRIPTION === "1" || process.env.VLLM_DISABLE_TRANSCRIPTION === "true";
  if (skip) {
    return res.status(503).json({ error: "Transcription disabled (VLLM_DISABLE_TRANSCRIPTION)" });
  }

  const audioPath = path.join(UPLOAD_DIR, name);
  try {
    await fs.promises.access(audioPath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: "File not found in uploads" });
  }

  const baseName = path.basename(name, path.extname(name));
  const transcriptFilename = `${baseName}.txt`;
  const transcriptPath = path.join(UPLOAD_DIR, transcriptFilename);

  try {
    const text = await transcribeFile(audioPath, name);
    await fs.promises.writeFile(transcriptPath, text, "utf8");
    res.json({
      ok: true,
      sourceFilename: name,
      transcriptFilename,
      transcriptionText: text,
    });
  } catch (err) {
    console.error("[transcribe existing]", err);
    res.status(502).json({
      ok: false,
      sourceFilename: name,
      transcriptionError: err.message || String(err),
    });
  }
});

app.post("/api/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file received" });
  }

  const { filename, path: audioPath } = req.file;
  const baseName = path.basename(filename, path.extname(filename));
  const transcriptFilename = `${baseName}.txt`;
  const transcriptPath = path.join(UPLOAD_DIR, transcriptFilename);

  const payload = {
    ok: true,
    filename,
    path: audioPath,
    transcriptFilename: null,
    transcriptPath: null,
    transcriptionText: null,
    transcriptionError: null,
  };

  const skip = process.env.VLLM_DISABLE_TRANSCRIPTION === "1" || process.env.VLLM_DISABLE_TRANSCRIPTION === "true";

  if (skip) {
    return res.json(payload);
  }

  try {
    const text = await transcribeFile(audioPath, filename);
    await fs.promises.writeFile(transcriptPath, text, "utf8");
    payload.transcriptFilename = transcriptFilename;
    payload.transcriptPath = transcriptPath;
    payload.transcriptionText = text;
  } catch (err) {
    payload.transcriptionError = err.message || String(err);
    console.error("[transcription]", err);
  }

  res.json(payload);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
