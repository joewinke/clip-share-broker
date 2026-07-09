# clip-share-broker

Turns an API key into a short-lived presigned MinIO/S3 upload URL, so the
helium-utilities-extension (and its native host) can share a video clip to a
public link without ever holding the long-lived storage secret. It also
tracks every clip it's minted a link for (filename, view count, short slug)
so a client can list/rename/delete them, and serves `/r/<slug>` short links
that redirect to the real file and count the view.

**Deployed and live:** `https://clip.marduk.app` (Coolify app
`clip-share-broker`, project `shared-services`, deployed from
`github.com/joewinke/clip-share-broker`, public repo — no secrets live in
the source, only in the app's env vars). MinIO bucket `helium-clips` is
provisioned and public-read.

## Why this exists

The extension has no server of its own. It cannot safely embed a MinIO
access/secret key (unprivileged JS, easy to inspect). This service is the
thin trusted middleman: given a valid API key, it hands back a presigned PUT
URL scoped to one bucket and a randomly-generated object path, valid for 5
minutes. The actual file bytes never pass through this service — the caller
PUTs straight to MinIO.

v1 is single-tenant (one API key -> one bucket via `BROKER_API_KEY` +
`MINIO_BUCKET`), but the auth check is a lookup table (`API_KEYS` env, JSON:
`{"<key>": {"bucket": "..."}}`) so adding real multi-tenant support later is
"add a row," not a rewrite.

## Endpoints

- `POST /presign` — body `{"filename": "clip.mp4", "contentType": "video/mp4"}`,
  header `Authorization: Bearer <api key>`. Returns
  `{"uploadUrl", "publicUrl", "shortUrl", "slug", "expiresIn", ...clip metadata}`.
- `GET /clips` — auth required. Lists every clip for the caller's bucket.
- `PATCH /clips/:slug` — auth required. Body `{"filename": "..."}`, renames.
- `DELETE /clips/:slug` — auth required. Deletes the S3 object and its record.
- `GET /r/:slug` — **public, no auth**. Records a view, 302s to the real file.
  This is the short link handed to whoever the clip is shared with.
- `GET /health` — `{"ok": true}`.

## Environment

| Var | Required | Notes |
|---|---|---|
| `MINIO_ENDPOINT` | yes | **must be the public S3 endpoint** (e.g. `https://media.marduk.app`), not an internal container hostname — presigned URLs are handed to callers outside the deployment network, so the signature has to be valid against an endpoint they can actually reach. `media.marduk.app` proxies the full S3 API (verified: PUT works, not just static GET). |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | yes | matches `minio-access-key` / `minio-secret-key` in jat-secret |
| `PUBLIC_MINIO_BASE_URL` | no | hostname used to build `publicUrl`; falls back to `MINIO_ENDPOINT` |
| `PUBLIC_BROKER_BASE_URL` | no | hostname used to build `shortUrl` (`<base>/r/<slug>`); falls back to `http://localhost:PORT` |
| `BROKER_API_KEY` + `MINIO_BUCKET` | yes (unless `API_KEYS` set) | single-tenant v1 |
| `API_KEYS` | no | JSON `{"<key>": {"bucket": "..."}}` — overrides the pair above for real multi-tenant |
| `DATA_DIR` | no | where `clips.json` lives; default `./data`. **Not currently on a persistent volume in the Coolify deploy** — a redeploy resets clip metadata (view counts, filenames, the slug->object mapping). The actual video files in MinIO are unaffected either way; only the tracking/short-link layer resets. Add a Coolify persistent volume mounted at this path to fix. |
| `PORT` | no | default `8787` |

## Known limitation

Clip metadata (`clips.json`) isn't on a persistent volume yet, so a redeploy
of this app wipes the clip list / view counts / short links, even though the
actual uploaded videos in MinIO are untouched. Low-priority since redeploys
are rare for a service this small, but worth fixing with a Coolify volume
mount at `DATA_DIR` before this sees heavy use.

## Local test

```bash
npm install
MINIO_ENDPOINT=https://media.marduk.app \
MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
BROKER_API_KEY=devkey MINIO_BUCKET=helium-clips \
npm start

curl -X POST localhost:8787/presign \
  -H "Authorization: Bearer devkey" -H "Content-Type: application/json" \
  -d '{"filename":"test.mp4","contentType":"video/mp4"}'
```
