import type { AttachmentDto, MessageDto, Peer, PublicUser } from "../shared/events";

export const SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const LOGIN_COOLDOWN_MS = 60 * 1000;
export const MESSAGE_PAGE_SIZE = 50;

export type UserRow = {
  id: string;
  email: string;
  username: string;
  display_name: string;
  created_at: number;
  deleted_at: number | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_msg_id: string;
  seq: number;
  body: string;
  created_at: number;
};

export type LoginTokenRow = {
  id: string;
  email: string;
  token_hash: string;
  purpose: "login" | "register";
  username: string | null;
  display_name: string | null;
  expires_at: number;
  used_at: number | null;
  created_at: number;
};

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.display_name,
  };
}

export function toMessage(row: MessageRow, attachments: AttachmentDto[] = []): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientMsgId: row.client_msg_id,
    seq: row.seq,
    body: row.body,
    createdAt: row.created_at,
    attachments,
  };
}

export function pairKey(left: string, right: string): string {
  return [left, right].sort().join(":");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function findUserBySession(db: D1Database, token: string): Promise<UserRow | null> {
  const tokenHash = await sha256(token);
  const now = Date.now();
  return db
    .prepare(
      `SELECT u.id, u.email, u.username, u.display_name, u.created_at, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.deleted_at IS NULL`,
    )
    .bind(tokenHash, now)
    .first<UserRow>();
}

export async function isBlocked(db: D1Database, left: string, right: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS blocked
       FROM blocks
       WHERE (blocker_id = ? AND blocked_id = ?)
          OR (blocker_id = ? AND blocked_id = ?)`,
    )
    .bind(left, right, right, left)
    .first();
  return row !== null;
}

export async function memberIds(db: D1Database, conversationId: string): Promise<string[]> {
  const result = await db
    .prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ?`)
    .bind(conversationId)
    .all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
}

export function tombstoneEmail(userId: string): string {
  return `deleted+${userId}@users.invalid`;
}

export function tombstoneUsername(userId: string): string {
  return `d${userId.replaceAll("-", "").slice(0, 19)}`;
}

export type ConversationRecord = {
  id: string;
  unreadCount: number;
  lastReadSeq: number;
  peerLastReadSeq: number;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  lastMessageSeq: number;
  peer: Peer;
};

type ConversationJoinRow = {
  id: string;
  unread_count: number;
  last_read_seq: number;
  peer_last_read_seq: number;
  last_message_at: number | null;
  last_message_preview: string | null;
  last_message_seq: number;
  peer_id: string;
  peer_username: string;
  peer_display_name: string;
  peer_deleted_at: number | null;
};

export function toConversation(row: ConversationJoinRow): ConversationRecord {
  return {
    id: row.id,
    unreadCount: row.unread_count,
    lastReadSeq: row.last_read_seq,
    peerLastReadSeq: row.peer_last_read_seq,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageSeq: row.last_message_seq,
    peer: {
      id: row.peer_id,
      username: row.peer_username,
      displayName: row.peer_deleted_at ? "Deleted user" : row.peer_display_name,
      deleted: row.peer_deleted_at !== null,
    },
  };
}

const conversationSelect = `
  SELECT c.id,
         me.unread_count,
         me.last_read_seq,
         other.last_read_seq AS peer_last_read_seq,
         c.last_message_at,
         c.last_message_preview,
         c.last_message_seq,
         peer.id AS peer_id,
         peer.username AS peer_username,
         peer.display_name AS peer_display_name,
         peer.deleted_at AS peer_deleted_at
  FROM conversation_members me
  JOIN conversations c ON c.id = me.conversation_id
  JOIN conversation_members other
    ON other.conversation_id = c.id
   AND other.user_id != me.user_id
  JOIN users peer ON peer.id = other.user_id
`;

export async function listConversations(db: D1Database, userId: string): Promise<ConversationRecord[]> {
  const result = await db
    .prepare(
      `${conversationSelect}
       WHERE me.user_id = ? AND c.type = 'direct'
       ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, c.created_at DESC`,
    )
    .bind(userId)
    .all<ConversationJoinRow>();
  return result.results.map(toConversation);
}

export async function getConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
): Promise<ConversationRecord | null> {
  const row = await db
    .prepare(`${conversationSelect} WHERE me.user_id = ? AND c.id = ? AND c.type = 'direct'`)
    .bind(userId, conversationId)
    .first<ConversationJoinRow>();
  return row ? toConversation(row) : null;
}
