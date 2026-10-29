import type { AttachmentDto } from "../shared/events";

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export type ImageContentType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type AttachmentRow = {
  id: string;
  conversation_id: string;
  uploader_id: string;
  message_id: string | null;
  r2_key: string;
  content_type: ImageContentType;
  byte_size: number;
  created_at: number;
};

export function sniffImage(bytes: Uint8Array): ImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function attachmentKey(conversationId: string, attachmentId: string): string {
  return `conversations/${conversationId}/${attachmentId}`;
}

export function toAttachment(row: Pick<AttachmentRow, "id" | "content_type" | "byte_size">): AttachmentDto {
  return { id: row.id, contentType: row.content_type, byteSize: row.byte_size };
}

export async function attachmentsForMessages(db: D1Database, messageIds: string[]): Promise<Map<string, AttachmentDto[]>> {
  const grouped = new Map<string, AttachmentDto[]>();
  if (messageIds.length === 0) return grouped;
  const placeholders = messageIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT id, message_id, content_type, byte_size
       FROM attachments
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(...messageIds)
    .all<Pick<AttachmentRow, "id" | "content_type" | "byte_size"> & { message_id: string }>();
  for (const row of result.results) {
    const list = grouped.get(row.message_id) ?? [];
    list.push(toAttachment(row));
    grouped.set(row.message_id, list);
  }
  return grouped;
}

export async function linkAttachments(
  db: D1Database,
  input: { messageId: string; conversationId: string; uploaderId: string; attachmentIds: string[] },
): Promise<AttachmentDto[] | null> {
  if (input.attachmentIds.length === 0) return [];
  if (input.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) return null;
  const placeholders = input.attachmentIds.map(() => "?").join(", ");
  const updated = await db
    .prepare(
      `UPDATE attachments
       SET message_id = ?
       WHERE id IN (${placeholders})
         AND conversation_id = ?
         AND uploader_id = ?
         AND message_id IS NULL`,
    )
    .bind(input.messageId, ...input.attachmentIds, input.conversationId, input.uploaderId)
    .run();
  if (updated.meta.changes !== input.attachmentIds.length) {
    await db.prepare(`UPDATE attachments SET message_id = NULL WHERE message_id = ?`).bind(input.messageId).run();
    return null;
  }
  const grouped = await attachmentsForMessages(db, [input.messageId]);
  return grouped.get(input.messageId) ?? [];
}

export async function undoMessageInsert(db: D1Database, conversationId: string, messageId: string, senderId: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE attachments SET message_id = NULL WHERE message_id = ?`).bind(messageId),
    db.prepare(`DELETE FROM messages WHERE id = ?`).bind(messageId),
    db
      .prepare(
        `UPDATE conversation_members
         SET unread_count = MAX(unread_count - 1, 0)
         WHERE conversation_id = ? AND user_id != ?`,
      )
      .bind(conversationId, senderId),
    db
      .prepare(
        `UPDATE conversations
         SET last_message_seq = COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id = ?1), 0),
             last_message_at = (SELECT created_at FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT 1),
             last_message_preview = (
               SELECT CASE WHEN length(trim(body)) > 0 THEN substr(body, 1, 140) ELSE 'Photo' END
               FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT 1
             ),
             last_message_sender_id = (
               SELECT sender_id FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT 1
             )
         WHERE id = ?1`,
      )
      .bind(conversationId),
  ]);
}
