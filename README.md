# Speech Recorder

Browser app with a **record/stop** control, optional **send** or **discard** after capture, an **Express** backend, and **OpenShift** / **Tekton** manifests for build and deploy.

## Features

- **Record** toggles microphone capture (MediaRecorder).
- After stop: **Send** uploads audio to `POST /api/upload` or **Discard** drops the blob.
- Backend saves files under `uploads/` (multipart field name: `audio`).

## Run locally

Requires **Node.js 18+**. Microphone access needs **HTTPS** or **localhost**.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The server listens on `0.0.0.0` and uses `PORT` from the environment (default `3000`).

## Project layout

| Path | Purpose |
|------|--------|
| `server.js` | Express server, static `public/`, upload handler |
| `public/` | `index.html`, `app.js`, `style.css` |
| `uploads/` | Saved recordings (created at runtime; ignored by git except `.gitkeep`) |
| `Containerfile` | Multi-stage image: `npm ci`, non-root–friendly permissions for OpenShift |
| `openshift/` | ImageStream, Deployment, Service, Route |
| `tekton/` | Git clone + Kaniko build/push Pipeline, example PipelineRun and PVC |

## Container image

Build context is the repo root. The image:

- Installs production dependencies with `npm ci`.
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
| `POST` | `/api/upload` | Multipart form field **`audio`** (file); responds with JSON including saved **`filename`** |

Max upload size: **100 MiB** (see `server.js`).
