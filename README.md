# Speech Recorder

Browser app with a **record/stop** control, optional **send** or **discard** after capture, an **Express** backend, and **OpenShift** / **Tekton** manifests for build and deploy.

## Features

- **Record** toggles microphone capture (MediaRecorder).
- After stop: **Send** uploads audio to `POST /api/upload` or **Discard** drops the blob.
- Separate **Transcribe** control: type an existing **`uploads/`** filename and run speech-to-text without recording.
- **What do you want?** textarea + **Submit**: saves typed text to **`uploads/manual-<timestamp>.txt`** with the same JSON shape as a successful speech transcript (no vLLM call).
- Backend saves files under `uploads/` (multipart field name: `audio`), then calls **vLLM** (OpenAI-compatible `POST /v1/chat/completions` with `input_audio`) to **transcribe** into a **`.txt`** file next to the recording.

## vLLM transcription

After each successful upload, the server reads the saved audio, base64-encodes it, and calls:

`{VLLM_BASE_URL}/v1/chat/completions`

using the [vLLM multimodal chat format](https://docs.vllm.ai/en/latest/features/multimodal_inputs.html) (`input_audio` + text instruction). The transcript is written to **`uploads/<same-basename>.txt`**.

**Audio pipeline:** Recordings are usually **WebM/Opus**. vLLM loads `input_audio` with **librosa/soundfile**, which does **not** understand WebM. Before calling vLLM, this app runs **`ffmpeg`** to produce **16 kHz mono PCM WAV** (aligned with Gemma 3n audio guidance). The container image installs **`ffmpeg`** via Alpine (`Containerfile`). For local development, install **`ffmpeg`** on your PATH.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VLLM_BASE_URL` | `http://redhataigemma-3n-e4b-it-fp8-dynamic-predictor:8080` | vLLM server (no trailing slash) |
| `VLLM_MODEL` | *(unset)* | Model id; if unset, uses the first model from `GET /v1/models` |
| `VLLM_API_KEY` | *(unset)* | Optional `Authorization: Bearer …` |
| `VLLM_MAX_TOKENS` | `8192` | `max_tokens` for completion (raise if `finish_reason=length` on long clips) |
| `VLLM_TEMPERATURE` | `0` | Sampling temperature (0 = greedy; good for transcription) |
| `VLLM_STOP_SEQUENCES` | *(unset)* | Comma-separated `stop` strings; default is `<end_of_turn>,<eos>,</s>` unless `VLLM_DISABLE_STOP=1` |
| `VLLM_DISABLE_STOP` | *(unset)* | Set to `1` to omit `stop` (only if the server rejects default stops) |
| `VLLM_EXTRA_JSON` | *(unset)* | JSON object merged into the chat-completions body (e.g. vLLM-specific flags) |
| `VLLM_REQUEST_TIMEOUT_MS` | `900000` | HTTP timeout for vLLM chat request (15 min; long audio + slow GPUs) |
| `VLLM_DEBUG_REQUEST` | *(unset)* | Set to `1` to log the outgoing chat-completions JSON (audio base64 redacted) |
| `VLLM_DEBUG_RESPONSE` | *(unset)* | Set to `1` or `true` to log the raw vLLM JSON body when assistant text is empty (debugging) |
| `VLLM_TRANSCRIBE_PROMPT` | *(built-in)* | User instruction text in the chat message |
| `VLLM_DISABLE_TRANSCRIPTION` | *(unset)* | Set to `1` or `true` to skip vLLM (audio only) |
| `VLLM_TLS_INSECURE` | *(unset)* | Set to `1` or `true` so vLLM `fetch` calls use an **undici** `Agent` with `rejectUnauthorized: false` (Node’s built-in `fetch` does not honor `NODE_TLS_REJECT_UNAUTHORIZED`). Use only for self-signed / private-CA vLLM URLs. |
| `VLLM_SKIP_FFMPEG` | *(unset)* | Set to `1` or `true` to send the raw file as `input_audio` (only useful for WAV already compatible with soundfile) |
| `FFMPEG_TIMEOUT_MS` | `300000` | Max time for the ffmpeg conversion step (ms) |

On OpenShift, **`openshift/deployment.yaml`** sets `VLLM_BASE_URL` to the in-namespace predictor service. Set **`VLLM_MODEL`** if `/v1/models` returns more than one entry or the first id is wrong.

### What are `stop` sequences?

The OpenAI-style **`stop`** field is a list of **short text snippets**. The inference server is supposed to **stop generating** as soon as the model’s **next output would include** one of those snippets (for example Gemma’s **`<end_of_turn>`**), instead of continuing until **`max_tokens`**.

**“Ensure stop sequences run”** only means: **(1)** the client sends **`stop`**, **(2)** vLLM honors it for that route, and **(3)** the model actually **emits** one of those strings before the cap. It is **not** something you “run” manually.

If you still see **`finish_reason: "length"`** with **`completion_tokens` === `max_tokens`** and **`content: ""`**, then generation **never stopped early** and **`message.content` stayed empty**—often a **vLLM + Gemma 3n multimodal** limitation or bug (wrong chat template, dtype, or adapter not filling `content`). Raising **`VLLM_MAX_TOKENS`** alone usually **does not** fix empty `content`. Use **`VLLM_DEBUG_REQUEST=1`** to confirm **`stop`** and **`max_tokens`** on the wire; fix **inference** (vLLM version, Red Hat model card, **bfloat16** vs float16). See also [Gemma empty-output discussion](https://github.com/vllm-project/vllm/issues?q=is%3Aissue+gemma+empty).

**Empty `message.content` with `finish_reason=length`:** This app sends default **`stop`** strings (`<end_of_turn>`, `<eos>`, `</s>`), **`max_tokens: 8192`**, and **`temperature: 0`**. If the problem persists, treat it as **server-side** unless your platform documents different **`stop`** strings or **`VLLM_EXTRA_JSON`** flags.

Large clips increase memory (WAV in memory + base64 JSON to vLLM).

## Run locally

Requires **Node.js 18+** and **`ffmpeg`** on `PATH` for transcription. Microphone access needs **HTTPS** or **localhost**.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The server listens on `0.0.0.0` and uses `PORT` from the environment (default `3000`).

## Project layout

| Path | Purpose |
|------|--------|
| `server.js` | Express server, static `public/`, upload + transcription orchestration |
| `vllm-transcribe.js` | vLLM OpenAI client: `input_audio`, model resolution |
| `public/` | `index.html`, `app.js`, `style.css` |
| `uploads/` | Saved recordings (created at runtime; ignored by git except `.gitkeep`) |
| `Containerfile` | Multi-stage image: `npm ci`, non-root–friendly permissions for OpenShift |
| `openshift/` | ImageStream, Deployment, Service, Route |
| `tekton/` | Git clone + Kaniko build/push Pipeline, example PipelineRun and PVC |

## Container image

Build context is the repo root. The image:

- Installs production dependencies with `npm ci`.
- Installs **`ffmpeg`** (WebM → WAV for vLLM).
- Sets `chgrp 0` and `chmod -R g=u` on `/app` so a **cluster-assigned UID** (with group `0`) can read the app and write `/app/uploads`.

### OpenShift and `restricted-v2`

Many OpenShift namespaces use **`restricted-v2`**, which only allows UIDs in a **project-specific range** (for example `1000940000–1000949999`). Fixed users like **`1001`** in the image (`USER 1001`) or in the Deployment (`runAsUser: 1001`) often **fail** SCC validation.

This repo’s **`Containerfile`** ends with **`USER 0`** (root in image metadata only). The **`openshift/deployment.yaml`** does **not** set `runAsUser` or `runAsNonRoot`, so OpenShift can inject a UID from your namespace range at admission. **Rebuild and push** the image after changing `USER` so the registry does not serve an old image config.

## OpenShift deploy (summary)

Apply order (use your namespace; replace placeholders):

1. **ImageStream** — `openshift/imagestream.yaml`
2. **Tekton Tasks + Pipeline** — `tekton/task-git-clone.yaml`, `tekton/task-build-push.yaml`, `tekton/pipeline.yaml`
3. **Registry push permission** for the Pipeline ServiceAccount, for example:

   ```bash
   oc policy add-role-to-user system:image-pusher system:serviceaccount:<namespace>:pipeline -n <namespace>
   ```

4. **PipelineRun** — copy/adapt `tekton/pipelinerun.example.yaml` (set `git-url` / `git-revision` if not using defaults). Optional: `tekton/pvc.example.yaml` instead of `emptyDir` for the workspace.
5. After the image exists on the ImageStream — **Deployment**, **Service**, **Route**:

   ```bash
   oc apply -f openshift/deployment.yaml -f openshift/service.yaml -f openshift/route.yaml
   ```

The Deployment annotation **`image.openshift.io/triggers`** rolls the app when **`speech-recorder:latest`** updates.

### Tekton defaults to customize

In **`tekton/task-git-clone.yaml`** and **`tekton/pipeline.yaml`**, set **`git-url`** (and **`git-revision`** if needed) to your Git remote. The example uses `https://github.com/your-org/speech-recorder.git`.

The push destination is:

`image-registry.openshift-image-registry.svc:5000/<PipelineRun namespace>/speech-recorder:<tag>`

### Uploads in the cluster

By default, recordings live on the **pod’s ephemeral filesystem** and are lost when the pod restarts. To persist them, add a **PVC** and mount it at **`/app/uploads`** in the Deployment.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Static UI |
| `POST` | `/api/upload` | Multipart field **`audio`**. JSON: **`filename`**, **`path`**, optional **`transcriptFilename`** / **`transcriptionText`**, or **`transcriptionError`** if vLLM failed (audio still saved). |
| `POST` | `/api/transcribe` | JSON body `{ "filename": "name-in-uploads.webm" }`. Reads that file from **`uploads/`**, runs vLLM, writes **`<basename>.txt`**. Responds with **`transcriptFilename`** or **`transcriptionError`** (502). |
| `POST` | `/api/submit-text` | JSON body `{ "text": string }`. Writes **`uploads/manual-<timestamp>.txt`**. Responds like a transcript: **`transcriptFilename`**, **`transcriptionText`**, **`transcriptPath`**. Max text length **256 KiB** (see `server.js`). |

Max upload size: **100 MiB** (see `server.js`). **`/api/transcribe`** only accepts a safe basename (no paths); missing file → 404.
