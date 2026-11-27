import type { MessageDto, MessagePage } from "../shared/events";
import { attachmentsForMessages } from "./attachments";
import { MESSAGE_PAGE_SIZE, memberIds, toMessage, type MessageRow } from "./db";
import { reactionsForMessages } from "./reactions";
import { fanOut } from "./user-hub";

export async function insertMessage(
  db: D1Database,
  input: { conversationId: string; senderId: string; clientMsgId: string; body: string },
): Promise<{ message: MessageDto; replay: boolean }> {
  const existing = await db
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND client_msg_id = ?`)
    .bind(input.conversationId, input.clientMsgId)
    .first<MessageRow>();
  if (existing) return { message: await hydrateMessage(db, existing), replay: true };

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await db
        .prepare(
          `INSERT INTO messages (id, conversation_id, sender_id, client_msg_id, seq, body, created_at)
           SELECT ?1, ?2, ?3, ?4,
                  COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id = ?2), 0) + 1,
                  ?5, ?6`,
        )
        .bind(id, input.conversationId, input.senderId, input.clientMsgId, input.body, createdAt)
        .run();
      if (result.meta.changes < 1) throw new Error("Message insert did not write a row");
      const row = await db.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
      if (!row) throw new Error("Inserted message could not be read");
      return { message: toMessage(row, []), replay: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("client_msg_id")) {
        const raced = await db
          .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND client_msg_id = ?`)
          .bind(input.conversationId, input.clientMsgId)
          .first<MessageRow>();
        if (raced) return { message: await hydrateMessage(db, raced), replay: true };
      }
      if (!message.includes("messages.seq") || attempt === 1) throw error;
    }
  }

  throw new Error("Message insert failed");
}

export async function publishMessage(env: Env, conversationId: string, message: MessageDto): Promise<void> {
  const ids = await memberIds(env.DB, conversationId);
  await fanOut(env, ids, { type: "message", conversationId, message });
}

export async function listMessages(
  db: D1Database,
  conversationId: string,
  options: { beforeSeq?: number; afterSeq?: number },
): Promise<MessagePage> {
  const limit = MESSAGE_PAGE_SIZE + 1;
  if (options.afterSeq !== undefined) {
    const result = await db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .bind(conversationId, options.afterSeq, limit)
      .all<MessageRow>();
    const page = takePage(result.results);
    return { messages: await withAttachments(db, page.rows), hasMore: page.hasMore };
  }

  const result = await db
    .prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND (? IS NULL OR seq < ?)
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .bind(conversationId, options.beforeSeq ?? null, options.beforeSeq ?? null, limit)
    .all<MessageRow>();
  const page = takePage(result.results);
  return { messages: (await withAttachments(db, page.rows)).reverse(), hasMore: page.hasMore };
}

function takePage(rows: MessageRow[]): { rows: MessageRow[]; hasMore: boolean } {
  if (rows.length <= MESSAGE_PAGE_SIZE) return { rows, hasMore: false };
  return { rows: rows.slice(0, MESSAGE_PAGE_SIZE), hasMore: true };
}

async function hydrateMessage(db: D1Database, row: MessageRow): Promise<MessageDto> {
  const [messages] = await withAttachments(db, [row]);
  if (!messages) throw new Error("Message could not be read");
  return messages;
}

async function withAttachments(db: D1Database, rows: MessageRow[]): Promise<MessageDto[]> {
  const ids = rows.map((row) => row.id);
  const [grouped, reactions] = await Promise.all([attachmentsForMessages(db, ids), reactionsForMessages(db, ids)]);
  return rows.map((row) => toMessage(row, grouped.get(row.id) ?? [], reactions.get(row.id) ?? []));
}

export async function markRead(
  db: D1Database,
  conversationId: string,
  userId: string,
  requestedSeq: number,
): Promise<number | null> {
  const current = await db
    .prepare(`SELECT last_read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?`)
    .bind(conversationId, userId)
    .first<{ last_read_seq: number }>();
  if (!current) return null;

  const conversation = await db
    .prepare(`SELECT last_message_seq FROM conversations WHERE id = ?`)
    .bind(conversationId)
    .first<{ last_message_seq: number }>();
  if (!conversation) return null;

  const nextSeq = Math.min(conversation.last_message_seq, Math.max(current.last_read_seq, requestedSeq));
  const unread = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ? AND seq > ? AND sender_id != ? AND deleted_at IS NULL`,
    )
    .bind(conversationId, nextSeq, userId)
    .first<{ count: number }>();

  await db
    .prepare(
      `UPDATE conversation_members
       SET last_read_seq = ?, unread_count = ?
       WHERE conversation_id = ? AND user_id = ?`,
    )
    .bind(nextSeq, unread?.count ?? 0, conversationId, userId)
    .run();

  return nextSeq;
}

export type DeleteMessageResult = "deleted" | "already_deleted" | "not_found" | "forbidden";

/**
 * Deletes a message for every participant. The row stays as a tombstone (empty body,
 * deleted_at set) so conversation sequence numbers never get reused, which keeps
 * after_seq syncing and read receipts consistent. Its images and reactions are removed.
 */
export async function deleteMessage(
  env: Env,
  input: { conversationId: string; messageId: string; userId: string },
): Promise<DeleteMessageResult> {
  const db = env.DB;
  const row = await db
    .prepare(`SELECT sender_id, seq, deleted_at FROM messages WHERE id = ? AND conversation_id = ?`)
    .bind(input.messageId, input.conversationId)
    .first<{ sender_id: string; seq: number; deleted_at: number | null }>();
  if (!row) return "not_found";
  if (row.sender_id !== input.userId) return "forbidden";
  if (row.deleted_at !== null) return "already_deleted";

  const tombstoned = await db
    .prepare(`UPDATE messages SET body = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(Date.now(), input.messageId)
    .run();
  if (tombstoned.meta.changes < 1) return "already_deleted";

  const keys = await db
    .prepare(`SELECT r2_key FROM attachments WHERE message_id = ?`)
    .bind(input.messageId)
    .all<{ r2_key: string }>();

  await db.batch([
    db.prepare(`DELETE FROM message_reactions WHERE message_id = ?`).bind(input.messageId),
    db.prepare(`DELETE FROM attachments WHERE message_id = ?`).bind(input.messageId),
    db
      .prepare(
        `UPDATE conversation_members
         SET unread_count = MAX(unread_count - 1, 0)
         WHERE conversation_id = ? AND user_id != ? AND last_read_seq < ?`,
      )
      .bind(input.conversationId, row.sender_id, row.seq),
    db
      .prepare(
        `UPDATE conversations
         SET last_message_preview = (
               SELECT CASE WHEN length(trim(body)) > 0 THEN substr(body, 1, 140) ELSE 'Photo' END
               FROM messages WHERE conversation_id = ?1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1
             ),
             last_message_sender_id = (
               SELECT sender_id FROM messages WHERE conversation_id = ?1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1
             )
         WHERE id = ?1`,
      )
      .bind(input.conversationId),
  ]);

  const r2Keys = keys.results.map((item) => item.r2_key);
  if (r2Keys.length > 0) {
    try {
      await env.MEDIA.delete(r2Keys);
    } catch (error) {
      console.error("attachment cleanup failed", input.messageId, error);
    }
  }
  return "deleted";
}

export async function publishMessageDeleted(env: Env, conversationId: string, messageId: string): Promise<void> {
  const ids = await memberIds(env.DB, conversationId);
  await fanOut(env, ids, { type: "message_deleted", conversationId, messageId });
}
