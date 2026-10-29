import type { MessageDto, MessagePage } from "../shared/events";
import { attachmentsForMessages } from "./attachments";
import { MESSAGE_PAGE_SIZE, memberIds, toMessage, type MessageRow } from "./db";
import { fanOut } from "./user-hub";

export async function insertMessage(
  db: D1Database,
  input: { conversationId: string; senderId: string; clientMsgId: string; body: string },
): Promise<{ message: MessageDto; replay: boolean }> {
  const existing = await db
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND client_msg_id = ?`)
    .bind(input.conversationId, input.clientMsgId)
    .first<MessageRow>();
  if (existing) {
    const grouped = await attachmentsForMessages(db, [existing.id]);
    return { message: toMessage(existing, grouped.get(existing.id) ?? []), replay: true };
  }

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
        if (raced) {
          const grouped = await attachmentsForMessages(db, [raced.id]);
          return { message: toMessage(raced, grouped.get(raced.id) ?? []), replay: true };
        }
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

async function withAttachments(db: D1Database, rows: MessageRow[]): Promise<MessageDto[]> {
  const grouped = await attachmentsForMessages(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toMessage(row, grouped.get(row.id) ?? []));
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
       WHERE conversation_id = ? AND seq > ? AND sender_id != ?`,
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
