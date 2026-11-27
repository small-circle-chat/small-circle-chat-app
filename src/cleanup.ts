/** Uploads younger than this are left alone in case a send is still in progress. */
export const ABANDONED_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

/**
 * Deletes images that were uploaded but never attached to a message (for example,
 * the tab closed between the upload and the send). The R2 file goes first: if that
 * fails, the row stays and the next run tries again, so files are never left untracked.
 */
export async function cleanupAbandonedAttachments(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - ABANDONED_UPLOAD_GRACE_MS;
  let removed = 0;
  for (;;) {
    const result = await env.DB.prepare(
      `SELECT id, r2_key FROM attachments
       WHERE message_id IS NULL AND created_at < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
      .bind(cutoff, BATCH_SIZE)
      .all<{ id: string; r2_key: string }>();
    const rows = result.results;
    if (rows.length === 0) break;

    await env.MEDIA.delete(rows.map((row) => row.r2_key));
    const placeholders = rows.map(() => "?").join(", ");
    const deleted = await env.DB.prepare(
      `DELETE FROM attachments WHERE id IN (${placeholders}) AND message_id IS NULL`,
    )
      .bind(...rows.map((row) => row.id))
      .run();
    removed += deleted.meta.changes;
    if (rows.length < BATCH_SIZE) break;
  }
  return removed;
}
