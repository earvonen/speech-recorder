(function () {
  "use strict";

  const recordBtn = document.getElementById("recordBtn");
  const recordLabel = document.getElementById("recordLabel");
  const statusEl = document.getElementById("status");
  const actionPanel = document.getElementById("actionPanel");
  const sendBtn = document.getElementById("sendBtn");
  const discardBtn = document.getElementById("discardBtn");

  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  /** @type {Blob | null} */
  let pendingBlob = null;
  /** @type {string | null} */
  let pendingMime = null;
  let objectUrl = null;

  function setStatus(message, kind) {
    statusEl.textContent = message || "";
    statusEl.classList.remove("error", "success");
    if (kind) statusEl.classList.add(kind);
  }

  function pickMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  function showActions(show) {
    actionPanel.hidden = !show;
    actionPanel.classList.toggle("hidden", !show);
    sendBtn.disabled = !show;
    discardBtn.disabled = !show;
  }

  function clearPending() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    pendingBlob = null;
    pendingMime = null;
    showActions(false);
  }

  function stopTracks() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  async function startRecording() {
    clearPending();
    setStatus("");

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setStatus("Microphone access denied or unavailable.", "error");
      return;
    }

    const mimeType = pickMimeType();
    try {
      mediaRecorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    pendingMime = mediaRecorder.mimeType || mimeType || "audio/webm";
    chunks = [];

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    mediaRecorder.onstop = () => {
      stopTracks();
      pendingBlob = new Blob(chunks, { type: pendingMime });
      chunks = [];
      if (pendingBlob.size === 0) {
        setStatus("No audio captured.", "error");
        clearPending();
        setIdleUi();
        return;
      }
      setStatus("Choose to send this recording or discard it.");
      showActions(true);
      setIdleUi();
    };

    mediaRecorder.start();
    recordBtn.classList.add("recording");
    recordBtn.setAttribute("aria-pressed", "true");
    recordLabel.textContent = "Stop";
    setStatus("Recording…");
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    } else {
      stopTracks();
      setIdleUi();
    }
    mediaRecorder = null;
  }

  function setIdleUi() {
    recordBtn.classList.remove("recording");
    recordBtn.setAttribute("aria-pressed", "false");
    recordLabel.textContent = "Record";
  }

  recordBtn.addEventListener("click", () => {
    if (recordBtn.disabled) return;
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      startRecording();
    } else {
      stopRecording();
    }
  });

  discardBtn.addEventListener("click", () => {
    clearPending();
    setStatus("Recording discarded.");
  });

  sendBtn.addEventListener("click", async () => {
    if (!pendingBlob) return;

    const ext = pendingMime.includes("mp4")
      ? "m4a"
      : pendingMime.includes("ogg")
        ? "ogg"
        : "webm";
    const filename = `recording.${ext}`;

    const form = new FormData();
    form.append("audio", pendingBlob, filename);

    sendBtn.disabled = true;
    discardBtn.disabled = true;
    setStatus("Uploading…");

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || res.statusText || "Upload failed");
      }

      let msg = `Saved as ${data.filename || "file"}.`;
      if (data.transcriptFilename) {
        msg += ` Transcript: ${data.transcriptFilename}.`;
      } else if (data.transcriptionError) {
        msg += ` Transcription failed: ${data.transcriptionError}`;
      }
      setStatus(msg, data.transcriptionError && !data.transcriptFilename ? "error" : "success");
      clearPending();
    } catch (e) {
      setStatus(e.message || "Upload failed.", "error");
      sendBtn.disabled = false;
      discardBtn.disabled = false;
    }
  });
})();
