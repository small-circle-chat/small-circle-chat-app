import type { MessageDto } from "../shared/events";
import { MAX_GROUP_MEMBERS, pairKey, randomToken } from "./db";
import { insertMessage } from "./messages";

export const MIN_GROUP_OTHERS = 2;

/** True when every id is someone `actorId` has a one-to-one chat with, and neither has blocked the other. */
async function areAddableContacts(db: D1Database, actorId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const keys = ids.map((id) => pairKey(actorId, id));
  const keyPlaceholders = keys.map(() => "?").join(", ");
  const idPlaceholders = ids.map(() => "?").join(", ");
  const numbered = ids.map((_, index) => `?${index + 2}`).join(", ");
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
      .bind(...keys, ...ids),
    db
      .prepare(
        `SELECT CASE WHEN blocker_id = ?1 THEN blocked_id ELSE blocker_id END AS id
         FROM blocks
         WHERE (blocker_id = ?1 AND blocked_id IN (${numbered}))
            OR (blocked_id = ?1 AND blocker_id IN (${numbered}))`,
      )
      .bind(actorId, ...ids),
  ]);
  const allowed = new Set((contacts?.results ?? []).map((row) => row.id));
  const blockedIds = new Set((blocked?.results ?? []).map((row) => row.id));
  return ids.every((id) => allowed.has(id) && !blockedIds.has(id));
}

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

  if (!(await areAddableContacts(db, creatorId, others))) return { kind: "not_allowed" };

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
  const names = await displayNames(db, [creatorId]);
  await postSystem(db, conversationId, creatorId, `${names.get(creatorId)} created the group`);
  return { kind: "created", conversationId, memberIds: [creatorId, ...others] };
}

export type LeaveOutcome = { kind: "not_group" } | { kind: "left"; remainingIds: string[]; system: MessageDto };

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
  const names = await displayNames(db, [userId]);
  await db.batch(statements);
  const system = await postSystem(db, conversationId, userId, `${names.get(userId)} left`);
  const remaining = await db
    .prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ?`)
    .bind(conversationId)
    .all<{ user_id: string }>();
  return { kind: "left", remainingIds: remaining.results.map((row) => row.user_id), system };
}

export type Role = "owner" | "admin" | "member";

const canManage = (role: Role | undefined) => role === "owner" || role === "admin";

async function groupRoles(db: D1Database, conversationId: string): Promise<Map<string, Role> | null> {
  const result = await db
    .prepare(
      `SELECT cm.user_id, cm.role FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.conversation_id = ? AND c.type = 'group'`,
    )
    .bind(conversationId)
    .all<{ user_id: string; role: Role }>();
  if (result.results.length === 0) return null;
  return new Map(result.results.map((row) => [row.user_id, row.role]));
}

async function displayNames(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db
    .prepare(`SELECT id, display_name FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .bind(...ids)
    .all<{ id: string; display_name: string }>();
  return new Map(result.results.map((row) => [row.id, row.display_name]));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Posts a line like "Alex added Blair" into the chat. */
async function postSystem(db: D1Database, conversationId: string, actorId: string, text: string): Promise<MessageDto> {
  const inserted = await insertMessage(db, {
    conversationId,
    senderId: actorId,
    clientMsgId: crypto.randomUUID(),
    body: text,
    kind: "system",
  });
  return inserted.message;
}

/** Everyone currently in the group. */
export async function groupMemberIds(db: D1Database, conversationId: string): Promise<string[]> {
  const result = await db
    .prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ?`)
    .bind(conversationId)
    .all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
}

/** Inserts members who see history only from now on. Throws "group_full" past 25. */
function insertMemberStatements(db: D1Database, conversationId: string, ids: string[], now: number): D1PreparedStatement[] {
  return ids.map((id) =>
    db
      .prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, history_from_seq, last_read_seq)
         SELECT ?1, ?2, 'member', ?3, seq_counter, seq_counter FROM conversations WHERE id = ?1`,
      )
      .bind(conversationId, id, now),
  );
}

function isGroupFull(error: unknown): boolean {
  return error instanceof Error && error.message.includes("group_full");
}

export type ManageOutcome =
  | { kind: "not_group" }
  | { kind: "forbidden" }
  | { kind: "not_allowed" }
  | { kind: "too_many" }
  | { kind: "not_member" }
  | { kind: "nothing" }
  | { kind: "done"; system: MessageDto; affectedIds: string[] };

export async function addMembers(
  db: D1Database,
  conversationId: string,
  actorId: string,
  requestedIds: string[],
): Promise<ManageOutcome> {
  const roles = await groupRoles(db, conversationId);
  if (!roles) return { kind: "not_group" };
  if (!canManage(roles.get(actorId))) return { kind: "forbidden" };
  const ids = requestedIds.filter((id) => id !== actorId && !roles.has(id));
  if (ids.length === 0) return { kind: "nothing" };
  if (roles.size + ids.length > MAX_GROUP_MEMBERS) return { kind: "too_many" };
  if (!(await areAddableContacts(db, actorId, ids))) return { kind: "not_allowed" };
  try {
    await db.batch(insertMemberStatements(db, conversationId, ids, Date.now()));
  } catch (error) {
    if (isGroupFull(error)) return { kind: "too_many" };
    throw error;
  }
  const names = await displayNames(db, [actorId, ...ids]);
  const system = await postSystem(
    db,
    conversationId,
    actorId,
    `${names.get(actorId)} added ${joinNames(ids.map((id) => names.get(id) ?? "someone"))}`,
  );
  return { kind: "done", system, affectedIds: ids };
}

export async function removeMember(
  db: D1Database,
  conversationId: string,
  actorId: string,
  targetId: string,
): Promise<ManageOutcome> {
  const roles = await groupRoles(db, conversationId);
  if (!roles) return { kind: "not_group" };
  const actorRole = roles.get(actorId);
  const targetRole = roles.get(targetId);
  if (!targetRole || targetId === actorId) return { kind: "not_member" };
  // Owners can remove anyone; admins can remove members but not other admins or the owner.
  if (!(actorRole === "owner" || (actorRole === "admin" && targetRole === "member"))) return { kind: "forbidden" };
  await db.prepare(`DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).bind(conversationId, targetId).run();
  const names = await displayNames(db, [actorId, targetId]);
  const system = await postSystem(db, conversationId, actorId, `${names.get(actorId)} removed ${names.get(targetId)}`);
  return { kind: "done", system, affectedIds: [targetId] };
}

export async function setMemberRole(
  db: D1Database,
  conversationId: string,
  actorId: string,
  targetId: string,
  role: "admin" | "member",
): Promise<ManageOutcome> {
  const roles = await groupRoles(db, conversationId);
  if (!roles) return { kind: "not_group" };
  if (roles.get(actorId) !== "owner") return { kind: "forbidden" };
  const current = roles.get(targetId);
  if (!current || current === "owner") return { kind: "not_member" };
  if (current === role) return { kind: "nothing" };
  await db
    .prepare(`UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?`)
    .bind(role, conversationId, targetId)
    .run();
  const names = await displayNames(db, [actorId, targetId]);
  const text =
    role === "admin"
      ? `${names.get(actorId)} made ${names.get(targetId)} an admin`
      : `${names.get(actorId)} removed ${names.get(targetId)} as an admin`;
  return { kind: "done", system: await postSystem(db, conversationId, actorId, text), affectedIds: [targetId] };
}

export async function renameGroup(
  db: D1Database,
  conversationId: string,
  actorId: string,
  title: string | null,
): Promise<ManageOutcome> {
  const roles = await groupRoles(db, conversationId);
  if (!roles) return { kind: "not_group" };
  if (!canManage(roles.get(actorId))) return { kind: "forbidden" };
  const current = await db.prepare(`SELECT title FROM conversations WHERE id = ?`).bind(conversationId).first<{ title: string | null }>();
  if ((current?.title ?? null) === title) return { kind: "nothing" };
  await db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).bind(title, conversationId).run();
  const names = await displayNames(db, [actorId]);
  const text = title ? `${names.get(actorId)} named the group \u201c${title}\u201d` : `${names.get(actorId)} removed the group name`;
  return { kind: "done", system: await postSystem(db, conversationId, actorId, text), affectedIds: [] };
}

/** The group's invite link token, created the first time an admin asks for it. */
export async function groupInviteToken(
  db: D1Database,
  conversationId: string,
  actorId: string,
  reset = false,
): Promise<string | "forbidden"> {
  const roles = await groupRoles(db, conversationId);
  if (!roles || !canManage(roles.get(actorId))) return "forbidden";
  if (!reset) {
    const existing = await db
      .prepare(`SELECT token FROM group_invites WHERE conversation_id = ?`)
      .bind(conversationId)
      .first<{ token: string }>();
    if (existing) return existing.token;
  }
  const token = randomToken();
  await db
    .prepare(
      `INSERT INTO group_invites (conversation_id, token, created_at) VALUES (?, ?, ?)
       ON CONFLICT (conversation_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
    )
    .bind(conversationId, token, Date.now())
    .run();
  return token;
}

export type JoinOutcome =
  | { kind: "invalid" }
  | { kind: "full" }
  | { kind: "joined"; conversationId: string; created: boolean; system: MessageDto | null };

/** Joins a group through its invite link. Already a member? It just opens the chat. */
export async function joinWithGroupInvite(db: D1Database, userId: string, token: string): Promise<JoinOutcome> {
  const invite = await db
    .prepare(`SELECT conversation_id FROM group_invites WHERE token = ?`)
    .bind(token)
    .first<{ conversation_id: string }>();
  if (!invite) return { kind: "invalid" };
  const conversationId = invite.conversation_id;
  const existing = await db
    .prepare(`SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?`)
    .bind(conversationId, userId)
    .first();
  if (existing) return { kind: "joined", conversationId, created: false, system: null };
  try {
    await db.batch(insertMemberStatements(db, conversationId, [userId], Date.now()));
  } catch (error) {
    if (isGroupFull(error)) return { kind: "full" };
    throw error;
  }
  const names = await displayNames(db, [userId]);
  const system = await postSystem(db, conversationId, userId, `${names.get(userId)} joined with the group's invite link`);
  return { kind: "joined", conversationId, created: true, system };
}
