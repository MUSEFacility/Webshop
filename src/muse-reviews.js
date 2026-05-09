// src/muse-reviews.js — server-to-server lookup of owner email + language
// from the muse-reviews app. Single endpoint:
//   GET /api/properties/by-parent-task/:id → { property: PropertyConfig } | 404
//
// The result is cached in-memory per isolate for IN_MEMORY_TTL_MS so the
// scans don't hammer Fly. Cache survives within a single Worker invocation
// and may persist across invocations on a warm isolate; a 5-min TTL keeps
// stale data short-lived.

const IN_MEMORY_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export async function getPropertyByParentTask(env, parentTaskId) {
  const cached = cache.get(parentTaskId);
  if (cached && Date.now() - cached.fetchedAt < IN_MEMORY_TTL_MS) {
    return cached.property;
  }
  if (!env.MUSE_REVIEWS_API_BASE || !env.MUSE_REVIEWS_API_USER || !env.MUSE_REVIEWS_API_PASS) {
    throw new Error('muse-reviews credentials not configured');
  }
  const auth = btoa(`${env.MUSE_REVIEWS_API_USER}:${env.MUSE_REVIEWS_API_PASS}`);
  const url = `${env.MUSE_REVIEWS_API_BASE}/api/properties/by-parent-task/${encodeURIComponent(parentTaskId)}`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (res.status === 404) {
    cache.set(parentTaskId, { property: null, fetchedAt: Date.now() });
    return null;
  }
  if (!res.ok) {
    throw new Error(`muse-reviews lookup ${res.status} for ${parentTaskId}`);
  }
  const { property } = await res.json();
  cache.set(parentTaskId, { property, fetchedAt: Date.now() });
  return property;
}
