const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { transcribeFile } = require("./vllm-transcribe");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

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
