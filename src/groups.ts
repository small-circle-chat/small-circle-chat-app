import { MAX_GROUP_MEMBERS, pairKey } from "./db";

export const MIN_GROUP_OTHERS = 2;

export type CreateGroupOutcome =
  | { kind: "too_few" }
  | { kind: "too_many" }
  | { kind: "not_allowed" }
  | { kind: "created"; conversationId: string; memberIds: string[] };

/**
 * Creates a group. You can only add people you already have a one-to-one chat with,
 * so groups can't be used to reach someone who never accepted your request.
 */
export async function createGroup(
  db: D1Database,
  creatorId: string,
  title: string | null,
  requestedIds: string[],
): Promise<CreateGroupOutcome> {
  const others = requestedIds.filter((id) => id !== creatorId);
  if (others.length < MIN_GROUP_OTHERS) return { kind: "too_few" };
  if (others.length + 1 > MAX_GROUP_MEMBERS) return { kind: "too_many" };

  const keys = others.map((id) => pairKey(creatorId, id));
  const keyPlaceholders = keys.map(() => "?").join(", ");
  const idPlaceholders = others.map(() => "?").join(", ");
  const [contacts, blocked] = await db.batch<{ id: string }>([
    db
      .prepare(
        `SELECT u.id
         FROM users u
         JOIN conversation_members cm ON cm.user_id = u.id
         JOIN conversations c ON c.id = cm.conversation_id
         WHERE c.type = 'direct' AND c.dm_pair_key IN (${keyPlaceholders})
           AND u.id IN (${idPlaceholders}) AND u.deleted_at IS NULL`,
      )
      .bind(...keys, ...others),
    db
      .prepare(
        `SELECT CASE WHEN blocker_id = ?1 THEN blocked_id ELSE blocker_id END AS id
         FROM blocks
         WHERE (blocker_id = ?1 AND blocked_id IN (${others.map((_, index) => `?${index + 2}`).join(", ")}))
            OR (blocked_id = ?1 AND blocker_id IN (${others.map((_, index) => `?${index + 2}`).join(", ")}))`,
      )
      .bind(creatorId, ...others),
  ]);
  const allowed = new Set((contacts?.results ?? []).map((row) => row.id));
  const blockedIds = new Set((blocked?.results ?? []).map((row) => row.id));
  if (others.some((id) => !allowed.has(id) || blockedIds.has(id))) return { kind: "not_allowed" };

  const conversationId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO conversations (id, type, title, created_at) VALUES (?, 'group', ?, ?)`).bind(conversationId, title, now),
    db
      .prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`)
      .bind(conversationId, creatorId, now),
    ...others.map((id) =>
      db
        .prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`)
        .bind(conversationId, id, now),
    ),
  ]);
  return { kind: "created", conversationId, memberIds: [creatorId, ...others] };
}

export type LeaveOutcome = { kind: "not_group" } | { kind: "left"; remainingIds: string[] };

/** Leaves a group. If the owner leaves, the longest-standing member takes over. */
export async function leaveGroup(db: D1Database, conversationId: string, userId: string): Promise<LeaveOutcome> {
  const membership = await db
    .prepare(
      `SELECT cm.role FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.conversation_id = ? AND cm.user_id = ? AND c.type = 'group'`,
    )
    .bind(conversationId, userId)
    .first<{ role: string }>();
  if (!membership) return { kind: "not_group" };

  const statements = [
    db.prepare(`DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).bind(conversationId, userId),
  ];
  if (membership.role === "owner") {
    statements.push(
      db
        .prepare(
          `UPDATE conversation_members SET role = 'owner'
           WHERE conversation_id = ?1 AND user_id = (
             SELECT user_id FROM conversation_members WHERE conversation_id = ?1
             ORDER BY joined_at ASC, user_id ASC LIMIT 1
           )`,
        )
        .bind(conversationId),
    );
  }
  await db.batch(statements);
  const remaining = await db
    .prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ?`)
    .bind(conversationId)
    .all<{ user_id: string }>();
  return { kind: "left", remainingIds: remaining.results.map((row) => row.user_id) };
}
