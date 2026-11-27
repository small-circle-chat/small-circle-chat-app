import type { ChatRequestDto, MessageDto } from "../shared/events";
import { isBlocked, pairKey, randomToken } from "./db";
import { joinWithGroupInvite } from "./groups";

export const DAILY_REQUEST_ATTEMPTS = 20;
export const DECLINE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Opens (or finds) the direct conversation between two people. */
export async function openDirectConversation(
  db: D1Database,
  userId: string,
  otherId: string,
): Promise<{ conversationId: string; created: boolean }> {
  const key = pairKey(userId, otherId);
  const existing = await db.prepare(`SELECT id FROM conversations WHERE dm_pair_key = ?`).bind(key).first<{ id: string }>();
  if (existing) return { conversationId: existing.id, created: false };

  const conversationId = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.batch([
      db.prepare(`INSERT INTO conversations (id, type, dm_pair_key, created_at) VALUES (?, 'direct', ?, ?)`).bind(
        conversationId,
        key,
        now,
      ),
      db
        .prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`)
        .bind(conversationId, userId, now),
      db
        .prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`)
        .bind(conversationId, otherId, now),
    ]);
    return { conversationId, created: true };
  } catch (error) {
    const raced = await db.prepare(`SELECT id FROM conversations WHERE dm_pair_key = ?`).bind(key).first<{ id: string }>();
    if (!raced) throw error;
    return { conversationId: raced.id, created: false };
  }
}

async function hasConversation(db: D1Database, left: string, right: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM conversations WHERE dm_pair_key = ?`).bind(pairKey(left, right)).first();
  return row !== null;
}

/** Marks any requests between the pair as accepted, so neither side keeps a stale request. */
async function settleRequests(db: D1Database, left: string, right: string): Promise<void> {
  await db
    .prepare(
      `UPDATE chat_requests SET status = 'accepted', responded_at = ?3
       WHERE status != 'accepted'
         AND ((sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1))`,
    )
    .bind(left, right, Date.now())
    .run();
}

export type RequestOutcome =
  | { kind: "limited" }
  | { kind: "quiet" }
  | { kind: "requested"; recipientId: string }
  | { kind: "opened"; conversationId: string; otherId: string };

/**
 * Sends a chat request by username. The caller always tells the sender the same thing,
 * so this never reveals whether the username exists, has blocked them, or declined before.
 */
export async function sendChatRequest(db: D1Database, senderId: string, username: string): Promise<RequestOutcome> {
  const now = Date.now();
  const attempts = await db
    .prepare(`SELECT COUNT(*) AS count FROM chat_request_attempts WHERE user_id = ? AND created_at > ?`)
    .bind(senderId, now - DAY_MS)
    .first<{ count: number }>();
  if ((attempts?.count ?? 0) >= DAILY_REQUEST_ATTEMPTS) return { kind: "limited" };
  await db.prepare(`INSERT INTO chat_request_attempts (user_id, created_at) VALUES (?, ?)`).bind(senderId, now).run();

  const target = await db
    .prepare(`SELECT id FROM users WHERE username = ? AND deleted_at IS NULL`)
    .bind(username)
    .first<{ id: string }>();
  if (!target || target.id === senderId) return { kind: "quiet" };
  if (await isBlocked(db, senderId, target.id)) return { kind: "quiet" };
  if (await hasConversation(db, senderId, target.id)) return { kind: "quiet" };

  // They already asked you: asking back opens the chat.
  const reverse = await db
    .prepare(`SELECT id FROM chat_requests WHERE sender_id = ? AND recipient_id = ? AND status = 'pending'`)
    .bind(target.id, senderId)
    .first<{ id: string }>();
  if (reverse) {
    const opened = await openDirectConversation(db, senderId, target.id);
    await settleRequests(db, senderId, target.id);
    return { kind: "opened", conversationId: opened.conversationId, otherId: target.id };
  }

  const existing = await db
    .prepare(`SELECT status, responded_at FROM chat_requests WHERE sender_id = ? AND recipient_id = ?`)
    .bind(senderId, target.id)
    .first<{ status: string; responded_at: number | null }>();
  if (existing?.status === "pending") return { kind: "quiet" };
  if (existing?.status === "declined" && (existing.responded_at ?? 0) > now - DECLINE_COOLDOWN_MS) return { kind: "quiet" };

  await db
    .prepare(
      `INSERT INTO chat_requests (id, sender_id, recipient_id, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT (sender_id, recipient_id) DO UPDATE SET
         status = 'pending', created_at = excluded.created_at, responded_at = NULL`,
    )
    .bind(crypto.randomUUID(), senderId, target.id, now)
    .run();
  return { kind: "requested", recipientId: target.id };
}

export async function listIncomingRequests(db: D1Database, userId: string): Promise<ChatRequestDto[]> {
  const result = await db
    .prepare(
      `SELECT r.id, r.created_at, u.username, u.display_name
       FROM chat_requests r
       JOIN users u ON u.id = r.sender_id
       WHERE r.recipient_id = ? AND r.status = 'pending' AND u.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = r.recipient_id AND b.blocked_id = r.sender_id)
              OR (b.blocker_id = r.sender_id AND b.blocked_id = r.recipient_id)
         )
       ORDER BY r.created_at DESC`,
    )
    .bind(userId)
    .all<{ id: string; created_at: number; username: string; display_name: string }>();
  return result.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    from: { username: row.username, displayName: row.display_name },
  }));
}

export type RequestResponse = "accept" | "decline" | "block";

export async function respondToRequest(
  db: D1Database,
  recipientId: string,
  requestId: string,
  response: RequestResponse,
): Promise<{ senderId: string; conversationId: string | null } | null> {
  const request = await db
    .prepare(`SELECT sender_id FROM chat_requests WHERE id = ? AND recipient_id = ? AND status = 'pending'`)
    .bind(requestId, recipientId)
    .first<{ sender_id: string }>();
  if (!request) return null;
  const now = Date.now();

  if (response === "accept") {
    if (await isBlocked(db, recipientId, request.sender_id)) return null;
    const opened = await openDirectConversation(db, recipientId, request.sender_id);
    await settleRequests(db, recipientId, request.sender_id);
    return { senderId: request.sender_id, conversationId: opened.conversationId };
  }

  const statements = [
    db.prepare(`UPDATE chat_requests SET status = 'declined', responded_at = ? WHERE id = ?`).bind(now, requestId),
  ];
  if (response === "block") {
    statements.push(
      db
        .prepare(
          `INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        )
        .bind(recipientId, request.sender_id, now),
    );
  }
  await db.batch(statements);
  return { senderId: request.sender_id, conversationId: null };
}

/** Returns the person's invite token, creating one the first time. */
export async function inviteToken(db: D1Database, userId: string): Promise<string> {
  const existing = await db.prepare(`SELECT token FROM invite_links WHERE user_id = ?`).bind(userId).first<{ token: string }>();
  if (existing) return existing.token;
  const token = randomToken();
  await db
    .prepare(`INSERT INTO invite_links (user_id, token, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING`)
    .bind(userId, token, Date.now())
    .run();
  const row = await db.prepare(`SELECT token FROM invite_links WHERE user_id = ?`).bind(userId).first<{ token: string }>();
  if (!row) throw new Error("Invite link could not be created");
  return row.token;
}

/** Replaces the person's invite token; the old link stops working. */
export async function resetInviteToken(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  await db
    .prepare(
      `INSERT INTO invite_links (user_id, token, created_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
    )
    .bind(userId, token, Date.now())
    .run();
  return token;
}

export type RedeemOutcome =
  | { kind: "invalid" }
  | { kind: "own" }
  | { kind: "full" }
  | { kind: "opened"; conversationId: string; ownerId: string; created: boolean }
  | { kind: "joined"; conversationId: string; created: boolean; system: MessageDto | null };

export async function redeemInvite(db: D1Database, userId: string, token: string): Promise<RedeemOutcome> {
  const owner = await db
    .prepare(
      `SELECT i.user_id FROM invite_links i JOIN users u ON u.id = i.user_id
       WHERE i.token = ? AND u.deleted_at IS NULL`,
    )
    .bind(token)
    .first<{ user_id: string }>();
  if (!owner) {
    // Not a person's link; it may be a group's.
    return joinWithGroupInvite(db, userId, token);
  }
  if (owner.user_id === userId) return { kind: "own" };
  if (await isBlocked(db, userId, owner.user_id)) return { kind: "invalid" };
  const opened = await openDirectConversation(db, userId, owner.user_id);
  await settleRequests(db, userId, owner.user_id);
  return { kind: "opened", conversationId: opened.conversationId, ownerId: owner.user_id, created: opened.created };
}

/** Weekly housekeeping: drop old attempt records and declines whose cooldown is over. */
export async function pruneRequestRecords(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM chat_request_attempts WHERE created_at < ?`).bind(now - 2 * DAY_MS),
    db.prepare(`DELETE FROM chat_requests WHERE status = 'declined' AND responded_at < ?`).bind(now - DECLINE_COOLDOWN_MS),
  ]);
}
