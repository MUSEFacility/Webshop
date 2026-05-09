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
//
// Source of truth: property config (owner email, language, repair_token,
// display_name) lives in muse-reviews. D1 only tracks per-house cooldown
// state (last_email_sent_at, last_email_type) keyed by parent_task_id.

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

async function loadCooldown(db, parentTaskId) {
  const r = await db.query(
    `SELECT last_email_sent_at, last_email_type
       FROM repair_tokens WHERE parent_task_id = ? LIMIT 1`,
    [parentTaskId],
  );
  return r.results?.[0] ?? null;
}

// Upsert cooldown state. Inserts a row if the parent_task_id is brand new
// (e.g., a freshly-configured house in muse-reviews that has never been
// emailed). app_number/token columns may still exist in the schema as
// legacy state; we only write the columns we own.
async function markEmailSent(db, parentTaskId, type, nowIso) {
  await db.query(
    `INSERT INTO repair_tokens (parent_task_id, token, app_number, last_email_sent_at, last_email_type, created_at)
       VALUES (?, '', NULL, ?, ?, ?)
     ON CONFLICT(parent_task_id) DO UPDATE
       SET last_email_sent_at = excluded.last_email_sent_at,
           last_email_type    = excluded.last_email_type`,
    [parentTaskId, nowIso, type, nowIso],
  );
}

// Pull the legacy app-number out of display_name. Most house IDs are like
// "108" or "108 Penthouse"; first digit run wins. Returns the original
// string if no digits are found, so the subject prefix never crashes.
function appNumberFor(property) {
  const dn = String(property?.display_name ?? '').trim();
  const m = dn.match(/\d+/);
  return m ? m[0] : dn;
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
      const property = await getPropertyByParentTask(env, parentTaskId);
      if (!property) continue;                           // house not configured
      if (!property.owner?.email) continue;              // no recipient
      if (!property.repair_token) continue;              // no magic-link token yet

      const cooldown = await loadCooldown(db, parentTaskId);
      const lastMs = cooldown?.last_email_sent_at ? Date.parse(cooldown.last_email_sent_at) : 0;
      if (lastMs && now - lastMs < NEW_SUBTASK_COOLDOWN_MS) continue;

      const html = renderNewSubtaskEmail({
        token: property.repair_token,
        subtaskNames: subs.map((s) => s.name).filter(Boolean),
      });
      await sendEmail(env, {
        from: FROM_ADDRESS,
        to: property.owner.email,
        bcc: NEW_SUBTASK_BCC,
        subject: newSubtaskSubject(appNumberFor(property)),
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
      const property = await getPropertyByParentTask(env, parentTaskId);
      if (!property) continue;
      if (!property.owner?.email) continue;
      if (!property.repair_token) continue;

      const cooldown = await loadCooldown(db, parentTaskId);
      const lastMs = cooldown?.last_email_sent_at ? Date.parse(cooldown.last_email_sent_at) : 0;
      if (lastMs && now - lastMs < REMINDER_COOLDOWN_MS) continue;

      const html = renderReminderEmail({
        token: property.repair_token,
        subtaskNames: subs.map((s) => s.name).filter(Boolean),
      });
      await sendEmail(env, {
        from: FROM_ADDRESS,
        to: property.owner.email,
        bcc: REMINDER_BCC,
        subject: reminderSubject(appNumberFor(property)),
        html,
      });

      await markEmailSent(db, parentTaskId, 'Reminder', nowIso);
    } catch (err) {
      console.error(`reminder scan failed for ${parentTaskId}:`, err);
    }
  }
}
