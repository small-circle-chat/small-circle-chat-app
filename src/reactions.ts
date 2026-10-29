import type { ReactionGroup } from "../shared/events";
import { memberIds } from "./db";
import { fanOut } from "./user-hub";

type ReactionRow = {
  message_id: string;
  user_id: string;
  emoji: string;
  updated_at: number;
};

export async function reactionsForMessages(db: D1Database, messageIds: string[]): Promise<Map<string, ReactionGroup[]>> {
  const grouped = new Map<string, ReactionGroup[]>();
  if (messageIds.length === 0) return grouped;
  const placeholders = messageIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT message_id, user_id, emoji, updated_at
       FROM message_reactions
       WHERE message_id IN (${placeholders})
       ORDER BY updated_at ASC, user_id ASC`,
    )
    .bind(...messageIds)
    .all<ReactionRow>();

  const drafts = new Map<string, Map<string, { emoji: string; userIds: string[]; firstAt: number }>>();
  for (const row of result.results) {
    let byEmoji = drafts.get(row.message_id);
    if (!byEmoji) {
      byEmoji = new Map();
      drafts.set(row.message_id, byEmoji);
    }
    const existing = byEmoji.get(row.emoji);
    if (existing) existing.userIds.push(row.user_id);
    else byEmoji.set(row.emoji, { emoji: row.emoji, userIds: [row.user_id], firstAt: row.updated_at });
  }

  for (const [messageId, byEmoji] of drafts) {
    const groups = [...byEmoji.values()]
      .sort((left, right) => left.firstAt - right.firstAt || left.emoji.localeCompare(right.emoji))
      .map(({ emoji, userIds }) => ({ emoji, userIds }));
    grouped.set(messageId, groups);
  }
  return grouped;
}

export async function setMessageReaction(
  db: D1Database,
  input: { conversationId: string; messageId: string; userId: string; emoji: string | null },
): Promise<{ reactions: ReactionGroup[]; changed: boolean } | null> {
  const message = await db
    .prepare(`SELECT id FROM messages WHERE id = ? AND conversation_id = ?`)
    .bind(input.messageId, input.conversationId)
    .first<{ id: string }>();
  if (!message) return null;

  const existing = await db
    .prepare(`SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?`)
    .bind(input.messageId, input.userId)
    .first<{ emoji: string }>();

  if (input.emoji === null) {
    if (!existing) return { reactions: await reactionsFor(db, input.messageId), changed: false };
    await db
      .prepare(`DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?`)
      .bind(input.messageId, input.userId)
      .run();
  } else if (existing?.emoji === input.emoji) {
    return { reactions: await reactionsFor(db, input.messageId), changed: false };
  } else {
    await db
      .prepare(
        `INSERT INTO message_reactions (message_id, user_id, emoji, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (message_id, user_id) DO UPDATE SET
           emoji = excluded.emoji,
           updated_at = excluded.updated_at`,
      )
      .bind(input.messageId, input.userId, input.emoji, Date.now())
      .run();
  }

  return { reactions: await reactionsFor(db, input.messageId), changed: true };
}

async function reactionsFor(db: D1Database, messageId: string): Promise<ReactionGroup[]> {
  const grouped = await reactionsForMessages(db, [messageId]);
  return grouped.get(messageId) ?? [];
}

export async function publishReaction(
  env: Env,
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string | null,
): Promise<void> {
  const ids = await memberIds(env.DB, conversationId);
  await fanOut(env, ids, { type: "reaction", conversationId, messageId, userId, emoji });
}
