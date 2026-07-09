// clip-share-broker — turns "Authorization: Bearer <api key>" into a
// short-lived presigned MinIO/S3 PUT URL, and tracks every clip it's minted
// a link for (slug, filename, view count) so a client can list/rename/delete
// them and so short links (/r/<slug>) can redirect + count a view. The
// upload itself always bypasses this service — only the URL and the
// lightweight redirect hop go through it, never the file bytes.
//
// v1 scope is single-tenant (one API key -> one bucket), but the auth check
// is a lookup table from the start, so adding real multi-tenant support later
// is "add a row to API_KEYS," not a rewrite.

import http from "node:http";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as store from "./store.mjs";

const PORT = process.env.PORT || 8787;
const REGION = "us-east-1"; // MinIO ignores this; the SDK requires something set
const UPLOAD_TTL_SECONDS = 300;
const ALLOWED_CONTENT_TYPES = new Set(["video/mp4", "image/png", "image/jpeg"]);
// base used to build the shortUrl returned from /presign and stored nowhere
// permanent — change this env var and every clip's shortUrl recomputes
// against the new base on the next list/presign call, no migration needed
const PUBLIC_BROKER_BASE_URL = (process.env.PUBLIC_BROKER_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const MINIO_ENDPOINT = requireEnv("MINIO_ENDPOINT");
const MINIO_ACCESS_KEY = requireEnv("MINIO_ACCESS_KEY");
const MINIO_SECRET_KEY = requireEnv("MINIO_SECRET_KEY");
const PUBLIC_MINIO_BASE_URL = (process.env.PUBLIC_MINIO_BASE_URL || MINIO_ENDPOINT).replace(/\/$/, "");

// API_KEYS, if set, is a JSON object: {"<api key>": {"bucket": "some-bucket"}}
// — the real multi-tenant path. Absent that, BROKER_API_KEY + MINIO_BUCKET
// gives the single-user v1 a one-line config instead of hand-writing JSON.
const KEYS = (() => {
  if (process.env.API_KEYS) {
    try {
      return JSON.parse(process.env.API_KEYS);
    } catch {
      throw new Error("API_KEYS is not valid JSON");
    }
  }
  const key = requireEnv("BROKER_API_KEY");
  const bucket = requireEnv("MINIO_BUCKET");
  return { [key]: { bucket } };
})();

const s3 = new S3Client({
  region: REGION,
  endpoint: MINIO_ENDPOINT,
  credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
  forcePathStyle: true, // MinIO convention: bucket in the path, not the hostname
});

function safeExt(filename) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(filename || ""));
  return m ? m[1].toLowerCase() : "bin";
}

function publicUrlFor(bucket, key) {
  return `${PUBLIC_MINIO_BASE_URL}/${bucket}/${key}`;
}

function shortUrlFor(slug) {
  return `${PUBLIC_BROKER_BASE_URL}/r/${slug}`;
}

async function freshSlug() {
  // 4 bytes of base64url ~= 6 chars, e.g. "l18fh3" — collisions are
  // astronomically unlikely at this scale, the retry loop is just cheap insurance
  for (let i = 0; i < 5; i++) {
    const slug = crypto.randomBytes(4).toString("base64url");
    if (!(await store.getClip(slug))) return slug;
  }
  throw new Error("could not allocate a unique slug");
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

async function readBody(req, limit = 1 << 16) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authTenant(req) {
  const auth = req.headers.authorization || "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return apiKey && KEYS[apiKey] ? KEYS[apiKey] : null;
}

function clipView(clip) {
  return {
    slug: clip.slug,
    filename: clip.filename,
    contentType: clip.contentType,
    size: clip.size,
    createdAt: clip.createdAt,
    views: clip.views,
    lastViewedAt: clip.lastViewedAt || null,
    publicUrl: publicUrlFor(clip.bucket, clip.key),
    shortUrl: shortUrlFor(clip.slug),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    // bearer-token API gated by design, not by origin — any origin can ask,
    // only a valid key gets a URL, so a permissive CORS policy is fine here
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    // public, unauthenticated: this is the short link itself — anyone the
    // clip is shared with hits this, not just the extension
    const redirectMatch = req.method === "GET" && /^\/r\/([\w-]+)$/.exec(req.url);
    if (redirectMatch) {
      const clip = await store.getClip(redirectMatch[1]);
      if (!clip) {
        json(res, 404, { error: "clip not found" });
        return;
      }
      await store.recordView(clip.slug);
      res.writeHead(302, { Location: publicUrlFor(clip.bucket, clip.key) });
      res.end();
      return;
    }

    // everything else needs a valid API key
    const tenant = authTenant(req);
    if (!tenant) {
      json(res, 401, { error: "invalid or missing API key" });
      return;
    }

    if (req.method === "POST" && req.url === "/presign") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        json(res, 400, { error: e.message || "invalid request body" });
        return;
      }
      const contentType = body.contentType || "video/mp4";
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        json(res, 400, { error: `unsupported contentType: ${contentType}` });
        return;
      }
      const slug = await freshSlug();
      // random object key — the caller's filename never dictates bucket
      // layout, so there's no path-traversal surface and no collision
      // between uploaders; the slug is the human-facing handle, not this
      const objectKey = `clips/${crypto.randomUUID()}.${safeExt(body.filename)}`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: tenant.bucket, Key: objectKey, ContentType: contentType }),
        { expiresIn: UPLOAD_TTL_SECONDS }
      );
      const clip = await store.createClip({
        slug, bucket: tenant.bucket, key: objectKey,
        filename: body.filename || objectKey, contentType, size: body.size || null,
      });
      json(res, 200, { uploadUrl, expiresIn: UPLOAD_TTL_SECONDS, ...clipView(clip) });
      return;
    }

    if (req.method === "GET" && req.url === "/clips") {
      const clips = await store.listClips(tenant.bucket);
      json(res, 200, { clips: clips.map(clipView) });
      return;
    }

    const clipMatch = /^\/clips\/([\w-]+)$/.exec(req.url);
    if (clipMatch) {
      const slug = clipMatch[1];
      const clip = await store.getClip(slug);
      if (!clip || clip.bucket !== tenant.bucket) {
        json(res, 404, { error: "clip not found" });
        return;
      }
      if (req.method === "PATCH") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          json(res, 400, { error: e.message || "invalid request body" });
          return;
        }
        const filename = (body.filename || "").trim();
        if (!filename) {
          json(res, 400, { error: "filename is required" });
          return;
        }
        const updated = await store.renameClip(slug, filename);
        json(res, 200, clipView(updated));
        return;
      }
      if (req.method === "DELETE") {
        await s3.send(new DeleteObjectCommand({ Bucket: clip.bucket, Key: clip.key })).catch(() => {});
        await store.deleteClip(slug);
        json(res, 200, { ok: true });
        return;
      }
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message || "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`clip-share-broker listening on :${PORT}`);
});
