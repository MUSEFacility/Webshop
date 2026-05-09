// src/muse-reviews.js — server-to-server lookup of property records.
//
// Two endpoints used:
//   GET /api/properties/by-parent-task/:id → { property } | 404   (cron lookup)
//   GET /api/properties/by-token/:token    → { property } | 404   (HTTP routes)
//
// Both results are cached in-memory per isolate for IN_MEMORY_TTL_MS so the
// scans don't hammer Fly. Cache may persist across invocations on a warm
// isolate; a 5-min TTL bounds staleness — important for tokens, since a
// freshly-rotated token in the Häuser tab would otherwise still 404 in
// the Worker for up to that window.

const IN_MEMORY_TTL_MS = 5 * 60 * 1000;
const byParentCache = new Map();
const byTokenCache = new Map();

function authHeader(env) {
  if (!env.MUSE_REVIEWS_API_BASE || !env.MUSE_REVIEWS_API_USER || !env.MUSE_REVIEWS_API_PASS) {
    throw new Error('muse-reviews credentials not configured');
  }
  return `Basic ${btoa(`${env.MUSE_REVIEWS_API_USER}:${env.MUSE_REVIEWS_API_PASS}`)}`;
}

async function fetchProperty(env, path, key, cache) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < IN_MEMORY_TTL_MS) {
    return cached.property;
  }
  const url = `${env.MUSE_REVIEWS_API_BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: authHeader(env) } });
  if (res.status === 404) {
    cache.set(key, { property: null, fetchedAt: Date.now() });
    return null;
  }
  if (!res.ok) {
    throw new Error(`muse-reviews ${path} ${res.status}`);
  }
  const { property } = await res.json();
  cache.set(key, { property, fetchedAt: Date.now() });
  return property;
}

export async function getPropertyByParentTask(env, parentTaskId) {
  return fetchProperty(
    env,
    `/api/properties/by-parent-task/${encodeURIComponent(parentTaskId)}`,
    parentTaskId,
    byParentCache,
  );
}

export async function getPropertyByToken(env, token) {
  return fetchProperty(
    env,
    `/api/properties/by-token/${encodeURIComponent(token)}`,
    token,
    byTokenCache,
  );
}
