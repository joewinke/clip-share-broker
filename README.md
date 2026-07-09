# clip-share-broker

Turns an API key into a short-lived presigned MinIO/S3 upload URL, so the
helium-utilities-extension (and its native host) can share a video clip to a
public link without ever holding the long-lived storage secret. The file
bytes never pass through this service — it only mints the URL; the caller
PUTs straight to MinIO.

## Why this exists

The extension has no server of its own. It cannot safely embed a MinIO
access/secret key (unprivileged JS, easy to inspect). This service is the
thin trusted middleman: given a valid API key, it hands back a presigned PUT
URL scoped to one bucket and a randomly-generated object path, valid for 5
minutes.

v1 is single-tenant (one API key -> one bucket via `BROKER_API_KEY` +
`MINIO_BUCKET`), but the auth check is a lookup table (`API_KEYS` env, JSON:
`{"<key>": {"bucket": "..."}}`) so adding real multi-tenant support later is
"add a row," not a rewrite.

## Endpoints

- `POST /presign` — body `{"filename": "clip.mp4", "contentType": "video/mp4"}`,
  header `Authorization: Bearer <api key>`. Returns
  `{"uploadUrl": "...", "publicUrl": "...", "expiresIn": 300}`.
- `GET /health` — `{"ok": true}`.

## Environment

| Var | Required | Notes |
|---|---|---|
| `MINIO_ENDPOINT` | yes | e.g. `http://127.0.0.1:5434` (matches the `minio-endpoint` jat-secret) |
| `MINIO_ACCESS_KEY` | yes | matches `minio-access-key` |
| `MINIO_SECRET_KEY` | yes | matches `minio-secret-key` |
| `PUBLIC_MINIO_BASE_URL` | no | public hostname for the returned link, e.g. `https://media.marduk.app`; falls back to `MINIO_ENDPOINT` |
| `BROKER_API_KEY` + `MINIO_BUCKET` | yes (unless `API_KEYS` set) | single-tenant v1 |
| `API_KEYS` | no | JSON `{"<key>": {"bucket": "..."}}` — overrides the pair above for real multi-tenant |
| `PORT` | no | default `8787` |

## Not done yet — before this can actually be used

1. **Provision a bucket** for clips (e.g. `helium-clips`) on the existing
   MinIO instance, and mark it public-read (same pattern as `storage.ts`'s
   `createBucket(name, {public: true})` / MIO-006 in
   `jat/ide/docs/internal/prd-infra-coolify.md`) — public-read is what lets
   `publicUrl` actually resolve for anyone the link is shared with.
2. **Mint an API key** (any random string) and set it as `BROKER_API_KEY` here
   AND paste the same value into the extension's clip-export panel ("Share to
   a link" -> API key field), along with this service's deployed URL as the
   "Broker URL" field.
3. **Deploy** — this is a plain Node app (`npm start`), no Dockerfile
   required; Coolify's nixpacks builder handles a `package.json` with a
   `start` script directly. Point it at a new Coolify app, set the env vars
   above, deploy.

Nothing here has been provisioned or deployed — this is the code, ready for
review.

## Local test

```bash
npm install
MINIO_ENDPOINT=http://127.0.0.1:5434 \
MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
BROKER_API_KEY=devkey MINIO_BUCKET=helium-clips \
npm start

curl -X POST localhost:8787/presign \
  -H "Authorization: Bearer devkey" -H "Content-Type: application/json" \
  -d '{"filename":"test.mp4","contentType":"video/mp4"}'
```
