import { Pool } from 'pg';
import { purgeAnalyticsEvents } from './events.js';

const retentionDays = Number(process.env.ANALYTICS_RETENTION_DAYS || 365);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const deleted = await purgeAnalyticsEvents(pool, retentionDays);
  console.log(JSON.stringify({ deleted, retentionDays }));
} finally {
  await pool.end();
}
