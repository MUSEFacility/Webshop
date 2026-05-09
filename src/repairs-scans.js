// src/repairs-scans.js — replaces the two n8n scheduled flows.
//
// runNewSubtaskScan: every 6h, finds subtasks created within the last 5h
//   that haven't triggered an email recently (24h cooldown per house),
//   sends one bilingual email per house grouping all new subtasks.
//
// runReminderScan: every 12h, finds subtasks ≥ 72h old in status
//   COMUNICATO or IN CORSO whose house hasn't been reminded in 72h, sends
//   one bilingual reminder per house grouping all open subtasks.
//
// At 300-house scale, both scans rely on ClickUp server-side filters so
// the list call returns a small, relevant slice instead of all parents +
// historical subtasks.

import { listTasksInList, REPAIRS_LIST_ID } from './clickup.js';
import { getPropertyByParentTask } from './muse-reviews.js';
import { sendEmail } from './mail.js';
import { makeDb } from './db.js';
import {
  newSubtaskSubject,
  reminderSubject,
  renderNewSubtaskEmail,
  renderReminderEmail,
} from './repairs-emails.js';

const NEW_SUBTASK_WINDOW_MS = 5 * 60 * 60 * 1000;     // 5h, mirrors n8n
const NEW_SUBTASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24h
const REMINDER_AGE_MS = 72 * 60 * 60 * 1000;          // 72h
const REMINDER_COOLDOWN_MS = 72 * 60 * 60 * 1000;     // 72h
const REMINDER_STATUSES = ['COMUNICATO', 'IN CORSO'];

const FROM_ADDRESS = 'MUSE.holiday <shop@muse.services>';
const NEW_SUBTASK_BCC = ['dolomites@muse.holiday', 'facilitymuse@gmail.com'];
const REMINDER_BCC = ['facilitymuse@gmail.com'];

// Group subtasks by their parent task id. We only ever care about subtasks
// (real repair items), never the parent rows themselves.
function groupByParent(tasks) {
  const out = new Map();
  for (const t of tasks) {
    if (!t.parent) continue;
    if (!out.has(t.parent)) out.set(t.parent, []);
    out.get(t.parent).push(t);
  }
  return out;
}

async function loadTokenRow(db, parentTaskId) {
  const r = await db.query(
    `SELECT token, app_number, last_email_sent_at, last_email_type
       FROM repair_tokens WHERE parent_task_id = ? LIMIT 1`,
    [parentTaskId],
  );
  return r.results?.[0] ?? null;
}

async function markEmailSent(db, parentTaskId, type, nowIso) {
  await db.query(
    `UPDATE repair_tokens
        SET last_email_sent_at = ?, last_email_type = ?
      WHERE parent_task_id = ?`,
    [nowIso, type, parentTaskId],
  );
}

export async function runNewSubtaskScan(env) {
  const now = Date.now();
  const tasks = await listTasksInList(env, REPAIRS_LIST_ID, {
    dateCreatedGt: now - NEW_SUBTASK_WINDOW_MS,
    subtasks: true,
  });

  const grouped = groupByParent(tasks);
  if (grouped.size === 0) return;

  const db = makeDb(env.DB);
  const nowIso = new Date(now).toISOString();

  for (const [parentTaskId, subs] of grouped) {
    try {
      const tokenRow = await loadTokenRow(db, parentTaskId);
      if (!tokenRow) continue;

      const lastMs = tokenRow.last_email_sent_at ? Date.parse(tokenRow.last_email_sent_at) : 0;
      if (lastMs && now - lastMs < NEW_SUBTASK_COOLDOWN_MS) continue;

      const property = await getPropertyByParentTask(env, parentTaskId);
      if (!property?.owner?.email) continue;

      const html = renderNewSubtaskEmail({
        token: tokenRow.token,
        subtaskNames: subs.map((s) => s.name).filter(Boolean),
      });
      await sendEmail(env, {
        from: FROM_ADDRESS,
        to: property.owner.email,
        bcc: NEW_SUBTASK_BCC,
        subject: newSubtaskSubject(tokenRow.app_number),
        html,
      });

      await markEmailSent(db, parentTaskId, 'NewSubtask', nowIso);
    } catch (err) {
      console.error(`new-subtask scan failed for ${parentTaskId}:`, err);
    }
  }
}

export async function runReminderScan(env) {
  const now = Date.now();
  const tasks = await listTasksInList(env, REPAIRS_LIST_ID, {
    statuses: REMINDER_STATUSES,
    subtasks: true,
  });

  // Status filter is server-side; we still need to drop subtasks that are
  // newer than 72h locally (ClickUp has no `date_created_lt` we can combine).
  const ageCutoff = now - REMINDER_AGE_MS;
  const stale = tasks.filter((t) => {
    const created = Number(t.date_created || 0);
    return t.parent && created && created <= ageCutoff;
  });

  const grouped = groupByParent(stale);
  if (grouped.size === 0) return;

  const db = makeDb(env.DB);
  const nowIso = new Date(now).toISOString();

  for (const [parentTaskId, subs] of grouped) {
    try {
      const tokenRow = await loadTokenRow(db, parentTaskId);
      if (!tokenRow) continue;

      const lastMs = tokenRow.last_email_sent_at ? Date.parse(tokenRow.last_email_sent_at) : 0;
      if (lastMs && now - lastMs < REMINDER_COOLDOWN_MS) continue;

      const property = await getPropertyByParentTask(env, parentTaskId);
      if (!property?.owner?.email) continue;

      const html = renderReminderEmail({
        token: tokenRow.token,
        subtaskNames: subs.map((s) => s.name).filter(Boolean),
      });
      await sendEmail(env, {
        from: FROM_ADDRESS,
        to: property.owner.email,
        bcc: REMINDER_BCC,
        subject: reminderSubject(tokenRow.app_number),
        html,
      });

      await markEmailSent(db, parentTaskId, 'Reminder', nowIso);
    } catch (err) {
      console.error(`reminder scan failed for ${parentTaskId}:`, err);
    }
  }
}
