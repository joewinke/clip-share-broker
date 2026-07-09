// Clip metadata store — a JSON file, not SQLite. At personal-use scale (one
// user, dozens to low-thousands of clips) a native DB dependency buys
// nothing but a build-time risk (native bindings failing on a fresh Coolify
// nixpacks image) in exchange for a table this file already models fine.
// Writes are serialized through one promise chain so concurrent requests
// never interleave a read-modify-write and silently drop each other's change.

import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "clips.json");

let cache = null; // { [slug]: {slug, bucket, key, filename, contentType, size, createdAt, views} }
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    cache = {};
  }
  return cache;
}

async function save() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, DB_PATH); // atomic — a crash mid-write never corrupts the live file
}

// every mutation goes through this so writes never race each other
function mutate(fn) {
  writeQueue = writeQueue.then(async () => {
    await load();
    const result = fn(cache);
    await save();
    return result;
  });
  return writeQueue;
}

export async function createClip({ slug, bucket, key, filename, contentType, size }) {
  return mutate((db) => {
    db[slug] = { slug, bucket, key, filename, contentType, size, createdAt: Date.now(), views: 0 };
    return db[slug];
  });
}

export async function listClips(bucket) {
  await load();
  return Object.values(cache)
    .filter((c) => c.bucket === bucket)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getClip(slug) {
  await load();
  return cache[slug] || null;
}

export async function renameClip(slug, filename) {
  return mutate((db) => {
    if (!db[slug]) return null;
    db[slug].filename = filename;
    return db[slug];
  });
}

export async function deleteClip(slug) {
  return mutate((db) => {
    const existed = db[slug];
    delete db[slug];
    return existed || null;
  });
}

export async function recordView(slug) {
  return mutate((db) => {
    if (!db[slug]) return null;
    db[slug].views = (db[slug].views || 0) + 1;
    db[slug].lastViewedAt = Date.now();
    return db[slug];
  });
}
