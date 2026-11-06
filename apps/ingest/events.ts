import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pathPattern = /^\/(?:[^/?#\\%\x00-\x1f\x7f]+(?:\/[^/?#\\%\x00-\x1f\x7f]+)*)?$/;
const unsafe = /[\r\n<>]/;

export interface AnalyticsEventInput {
  siteId: string;
  eventId?: string;
  releaseId?: string;
  eventType?: string;
  path: string;
  referrer?: string;
  device?: string;
  visitorId?: string;
  sessionId?: string;
}

export function validateEvent(
  input: unknown,
): Required<Pick<AnalyticsEventInput, 'siteId' | 'path'>> &
  Omit<AnalyticsEventInput, 'siteId' | 'path' | 'visitorId' | 'sessionId'> & {
    visitorHash?: string;
    sessionHash?: string;
  } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid event payload');
  const value = input as AnalyticsEventInput;
  if (
    !uuid.test(value.siteId) ||
    (value.eventId !== undefined && !uuid.test(value.eventId)) ||
    typeof value.path !== 'string' ||
    !pathPattern.test(value.path) ||
    /^\/(?:api|_nuxt|preview)(?:\/|$)/i.test(value.path)
  )
    throw new Error('Invalid event identity');
  const eventType = value.eventType ?? 'page_view';
  if (!/^[a-z][a-z0-9_.-]{0,48}$/.test(eventType)) throw new Error('Invalid event type');
  const bounded = (candidate: unknown, max: number, label: string) => {
    if (candidate === undefined || candidate === '') return undefined;
    if (typeof candidate !== 'string' || candidate.length > max || unsafe.test(candidate))
      throw new Error(`Invalid ${label}`);
    return candidate;
  };
  const releaseId = bounded(value.releaseId, 128, 'release');
  const referrer = bounded(value.referrer, 1000, 'referrer');
  const device = bounded(value.device, 80, 'device');
  const visitorHash = value.visitorId
    ? createHash('sha256').update(value.visitorId).digest('hex')
    : undefined;
  const sessionHash = value.sessionId
    ? createHash('sha256').update(value.sessionId).digest('hex')
    : undefined;
  return {
    siteId: value.siteId,
    path: value.path,
    eventType,
    ...(value.eventId ? { eventId: value.eventId } : {}),
    ...(releaseId ? { releaseId } : {}),
    ...(referrer ? { referrer } : {}),
    ...(device ? { device } : {}),
    ...(visitorHash ? { visitorHash } : {}),
    ...(sessionHash ? { sessionHash } : {}),
  };
}

export async function ingestEvent(
  pool: Pool,
  workspaceId: string,
  input: unknown,
  now = new Date(),
): Promise<{ id: string; duplicate: boolean }> {
  if (!uuid.test(workspaceId)) throw new Error('Invalid workspace');
  const event = validateEvent(input);
  const id = randomUUID();
  const eventId = event.eventId || id;
  const result = await pool.query(
    `INSERT INTO "AnalyticsEvent" ("id","workspaceId","siteId","eventId","releaseId","eventType","path","referrer","device","visitorHash","sessionHash","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT ("siteId","eventId") DO NOTHING RETURNING "id"`,
    [
      id,
      workspaceId,
      event.siteId,
      eventId,
      event.releaseId ?? null,
      event.eventType,
      event.path,
      event.referrer ?? null,
      event.device ?? null,
      event.visitorHash ?? null,
      event.sessionHash ?? null,
      now,
    ],
  );
  return { id: result.rowCount ? result.rows[0].id : eventId, duplicate: !result.rowCount };
}

export async function purgeAnalyticsEvents(
  pool: Pool,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
    throw new Error('Invalid analytics retention');
  const result = await pool.query('DELETE FROM "AnalyticsEvent" WHERE "createdAt" < $1', [
    new Date(now.getTime() - retentionDays * 86400000),
  ]);
  return result.rowCount || 0;
}
