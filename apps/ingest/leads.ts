import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const allowedSources = new Set(['contact', 'quote', 'newsletter', 'callback']);
const unsafe = /<[^>]*>|javascript:|data:text\/html|on[a-z]+\s*=/i;

export interface LeadInput {
  siteId: string;
  source: string;
  schemaVersion?: number;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  fields?: Record<string, string>;
  honeypot?: string;
  idempotencyKey?: string;
}

export interface ValidatedLead {
  siteId: string;
  source: string;
  schemaVersion: number;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  fields: Record<string, string>;
  dedupeKey: string;
}

function text(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || unsafe.test(normalized))
    throw new Error(`Invalid ${label}`);
  return normalized;
}

export function validateLead(input: unknown): ValidatedLead {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid lead payload');
  const value = input as LeadInput;
  if (!uuid.test(value.siteId)) throw new Error('Invalid site');
  if (typeof value.source !== 'string' || !allowedSources.has(value.source))
    throw new Error('Invalid lead source');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    throw new Error('Unsupported lead schema');
  if (value.honeypot) throw new Error('Rejected lead');
  const name = text(value.name, 120, 'name');
  const normalizedEmail = text(value.email, 254, 'email');
  if (normalizedEmail && !email.test(normalizedEmail)) throw new Error('Invalid email');
  const phone = text(value.phone, 64, 'phone');
  const message = text(value.message, 4000, 'message');
  const fields = value.fields === undefined ? {} : value.fields;
  if (
    !fields ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    Object.keys(fields).length > 20
  )
    throw new Error('Invalid lead fields');
  const safeFields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,48}$/.test(key)) throw new Error('Invalid lead field');
    const field = text(raw, 1000, `field ${key}`);
    if (field !== undefined) safeFields[key] = field;
  }
  if (!normalizedEmail && !phone && !message && Object.keys(safeFields).length === 0)
    throw new Error('Lead requires contact details');
  const dedupeSource =
    value.idempotencyKey?.trim() ||
    [
      normalizedEmail?.toLowerCase() || '',
      phone || '',
      message || '',
      JSON.stringify(safeFields),
    ].join('|');
  const dedupeKey = createHash('sha256')
    .update(`${value.siteId}|${value.source}|${dedupeSource}`)
    .digest('hex');
  return {
    siteId: value.siteId,
    source: value.source,
    schemaVersion: value.schemaVersion ?? 1,
    ...(name ? { name } : {}),
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
    ...(phone ? { phone } : {}),
    ...(message ? { message } : {}),
    fields: safeFields,
    dedupeKey,
  };
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
  status: 'new' | 'duplicate';
  notificationStatus: 'pending';
}

export async function ingestLead(
  pool: Pool,
  workspaceId: string,
  input: unknown,
  options: { ip?: string; now?: Date } = {},
): Promise<IngestResult> {
  if (!uuid.test(workspaceId)) throw new Error('Invalid workspace');
  const lead = validateLead(input);
  const now = options.now ?? new Date();
  const ipHash = options.ip ? createHash('sha256').update(options.ip).digest('hex') : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ipHash) {
      // A transaction-scoped lock serializes only this site's IP quota.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `lead-quota:${lead.siteId}:${ipHash}`,
      ]);
    }
    const existing = await client.query<{ id: string }>(
      'SELECT "id" FROM "Lead" WHERE "siteId"=$1 AND "dedupeKey"=$2',
      [lead.siteId, lead.dedupeKey],
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return {
        id: existing.rows[0].id,
        duplicate: true,
        status: 'duplicate',
        notificationStatus: 'pending',
      };
    }
    const recent = ipHash
      ? await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM "Lead" WHERE "siteId" = $1 AND "ipHash" = $2 AND "createdAt" > $3',
          [lead.siteId, ipHash, new Date(now.getTime() - 60_000)],
        )
      : { rows: [{ count: '0' }] };
    if (Number(recent.rows[0]?.count || 0) >= 5) throw new Error('Lead rate limited');
    const id = randomUUID();
    const result = await client.query<{ id: string; notificationStatus: 'pending' }>(
      `INSERT INTO "Lead" ("id","workspaceId","siteId","source","schemaVersion","name","email","phone","message","fields","dedupeKey","ipHash","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$13)
      ON CONFLICT ("siteId","dedupeKey") DO NOTHING
      RETURNING "id","notificationStatus"`,
      [
        id,
        workspaceId,
        lead.siteId,
        lead.source,
        lead.schemaVersion,
        lead.name ?? null,
        lead.email ?? null,
        lead.phone ?? null,
        lead.message ?? null,
        JSON.stringify(lead.fields),
        lead.dedupeKey,
        ipHash,
        now,
      ],
    );
    await client.query('COMMIT');
    if (!result.rowCount)
      return {
        id: lead.dedupeKey,
        duplicate: true,
        status: 'duplicate',
        notificationStatus: 'pending',
      };
    return {
      id: result.rows[0].id,
      duplicate: false,
      status: 'new',
      notificationStatus: result.rows[0].notificationStatus,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the original intake failure. */
    }
    throw error;
  } finally {
    client.release();
  }
}
