// src/clickup.js — ClickUp REST helpers for the repairs portal.
//
// Workers can't reuse the n8n OAuth flow, so we authenticate with a
// Personal API Token in env.CLICKUP_TOKEN (ClickUp profile → Apps).

const BASE = 'https://api.clickup.com/api/v2';

export const REPAIRS_LIST_ID = '901520930726';
export const OWNER_COMMENT_FIELD_ID = '8d333333-de44-4f45-b4d1-079540d99313';

async function cu(env, path, init = {}) {
  if (!env.CLICKUP_TOKEN) throw new Error('CLICKUP_TOKEN not configured');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: env.CLICKUP_TOKEN,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ClickUp ${res.status} ${path}: ${text}`);
  }
  return res.json();
}

export async function getTaskWithSubtasks(env, parentId) {
  return cu(env, `/task/${parentId}?include_subtasks=true`);
}

export async function getTask(env, taskId) {
  return cu(env, `/task/${taskId}`);
}

// Server-side filtered list query. Mirrors the n8n "Get many tasks" node but
// pushes filters to ClickUp so we don't pull pages then discard.
//
// opts:
//   statuses?:     string[]   → statuses[]=A&statuses[]=B
//   dateCreatedGt?: number    → date_created_gt=<unix-ms>
//   subtasks?:     boolean    → include subtasks (default true; both scans need it)
export async function listTasksInList(env, listId, opts = {}) {
  const params = new URLSearchParams({
    archived: 'false',
    include_closed: 'false',
    subtasks: String(opts.subtasks ?? true),
  });
  if (opts.dateCreatedGt) params.set('date_created_gt', String(opts.dateCreatedGt));
  if (opts.statuses && opts.statuses.length) {
    for (const s of opts.statuses) params.append('statuses[]', s);
  }

  const out = [];
  for (let page = 0; ; page++) {
    params.set('page', String(page));
    const data = await cu(env, `/list/${listId}/task?${params}`);
    const tasks = data.tasks || [];
    out.push(...tasks);
    if (tasks.length < 100) break;
  }
  return out;
}

export async function updateTaskStatus(env, taskId, status) {
  return cu(env, `/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

export async function setOwnerCommentField(env, taskId, value) {
  return cu(env, `/task/${taskId}/field/${OWNER_COMMENT_FIELD_ID}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export async function postTaskComment(env, taskId, commentText) {
  return cu(env, `/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: commentText, notify_all: true }),
  });
}

export function extractOwnerComment(customFields) {
  if (!Array.isArray(customFields)) return '';
  const f = customFields.find((x) => x.id === OWNER_COMMENT_FIELD_ID);
  if (!f || f.value == null) return '';
  return typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
}
