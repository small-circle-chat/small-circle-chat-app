import { Hono, type Context } from "hono";
import type { ConversationDto } from "../shared/events";
import {
  LOGIN_COOLDOWN_MS,
  LOGIN_TOKEN_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearSessionCookie,
  findUserBySession,
  getConversation,
  isBlocked,
  listConversations,
  pairKey,
  randomToken,
  readCookie,
  sessionCookie,
  sha256,
  toPublicUser,
  tombstoneEmail,
  tombstoneUsername,
  type LoginTokenRow,
  type UserRow,
} from "./db";
import {
  attachmentKey,
  linkAttachments,
  MAX_ATTACHMENT_BYTES,
  sniffImage,
  undoMessageInsert,
} from "./attachments";
import { deliverMagicLink, MailDeliveryError } from "./mail";
import { insertMessage, listMessages, markRead, publishMessage } from "./messages";
import { publishReaction, setMessageReaction } from "./reactions";
import { fanOut, UserHub } from "./user-hub";
import {
  allowsDevLink,
  normalizeAttachmentIds,
  normalizeClientMessageId,
  normalizeDisplayName,
  normalizeEmail,
  normalizeMessageBody,
  normalizeReactionEmoji,
  normalizeUsername,
  normalizeUuid,
  sameOrigin,
} from "./validate";

type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
  };
};

type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path === "/api/health") return next();
  if (c.req.method === "GET" && c.req.path === "/api/ws") return next();

  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (!token) {
    if (isPublicAuth(c.req.path)) return next();
    return error(c, 401, "unauthorized", "Sign in to continue.");
  }

  const user = await findUserBySession(c.env.DB, token);
  if (!user) {
    if (isPublicAuth(c.req.path)) return next();
    return error(c, 401, "unauthorized", "Sign in to continue.");
  }
  c.set("user", user);
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/auth/register", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const body = await readJson(c);
  if (!body) return error(c, 400, "invalid_json", "Send a JSON request.");

  const email = normalizeEmail(body.email);
  const username = normalizeUsername(body.username);
  const displayName = normalizeDisplayName(body.displayName);
  if (!email || !username || !displayName) {
    return error(c, 400, "invalid_input", "Check the email, username, and display name.");
  }
  if (!(await allow(c.env.AUTH_RATE_LIMITER, `register:${email}`))) {
    return error(c, 429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  }

  const existing = await c.env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>();
  if (existing && !existing.deleted_at) {
    return sendLink(c, email, "login", null, null);
  }

  const usernameOwner = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first();
  if (usernameOwner) {
    return c.json({ ok: true, message: "Check your email for a sign-in link." });
  }

  return sendLink(c, email, "register", username, displayName);
});

app.post("/api/auth/login", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const body = await readJson(c);
  if (!body) return error(c, 400, "invalid_json", "Send a JSON request.");
  const email = normalizeEmail(body.email);
  if (!email) return error(c, 400, "invalid_input", "Enter a valid email address.");
  if (!(await allow(c.env.AUTH_RATE_LIMITER, `login:${email}`))) {
    return error(c, 429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  }

  const existing = await c.env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>();
  if (!existing || existing.deleted_at) {
    return c.json({ ok: true, message: "Check your email for a sign-in link." });
  }
  return sendLink(c, email, "login", null, null);
});

app.post("/api/auth/verify", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const body = await readJson(c);
  if (!body || typeof body.token !== "string" || body.token.length < 20) {
    return error(c, 400, "invalid_token", "This sign-in link is invalid.");
  }

  const tokenHash = await sha256(body.token);
  const now = Date.now();
  const token = await c.env.DB.prepare(
    `SELECT * FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<LoginTokenRow>();
  if (!token) return error(c, 400, "invalid_token", "This sign-in link is invalid or expired.");

  const consumed = await c.env.DB.prepare(
    `UPDATE login_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
  )
    .bind(now, token.id)
    .run();
  if (consumed.meta.changes !== 1) {
    return error(c, 400, "invalid_token", "This sign-in link is invalid or expired.");
  }

  let user = await c.env.DB.prepare(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`)
    .bind(token.email)
    .first<UserRow>();

  if (token.purpose === "register") {
    if (!token.username || !token.display_name) {
      return error(c, 400, "invalid_token", "This sign-in link is invalid.");
    }
    if (!user) {
      const created = await createUser(c.env.DB, token.email, token.username, token.display_name, now);
      if (!created) return error(c, 409, "username_taken", "That username was just taken. Request a new link.");
      user = created;
    }
  }

  if (!user) return error(c, 400, "invalid_token", "This sign-in link is invalid or expired.");
  return startSession(c, user, now);
});

app.post("/api/auth/logout", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(token);
    await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
  }
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const user = c.get("user");
  if (!user) return error(c, 401, "unauthorized", "Sign in to continue.");
  return c.json({ user: toPublicUser(user) });
});

app.patch("/api/me", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const body = await readJson(c);
  if (!body) return error(c, 400, "invalid_json", "Send a JSON request.");

  const hasUsername = Object.prototype.hasOwnProperty.call(body, "username");
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "displayName");
  if (!hasUsername && !hasDisplayName) {
    return error(c, 400, "invalid_input", "Enter a username or display name.");
  }
  const username = hasUsername ? normalizeUsername(body.username) : user.username;
  const displayName = hasDisplayName ? normalizeDisplayName(body.displayName) : user.display_name;
  if (!username || !displayName) {
    return error(c, 400, "invalid_input", "Check the username and display name.");
  }
  if (!(await allow(c.env.AUTH_RATE_LIMITER, `profile:${user.id}`))) {
    return error(c, 429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  }

  let updated;
  try {
    updated = await c.env.DB.prepare(
      `UPDATE users
       SET username = ?, display_name = ?
       WHERE id = ? AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM users AS taken WHERE taken.username = ? AND taken.id != ?
         )`,
    )
      .bind(username, displayName, user.id, username, user.id)
      .run();
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("UNIQUE")) return error(c, 409, "username_taken", "That username is taken.");
    throw caught;
  }
  if (updated.meta.changes !== 1) return error(c, 409, "username_taken", "That username is taken.");

  const fresh = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first<UserRow>();
  if (!fresh) return error(c, 401, "unauthorized", "Sign in to continue.");
  return c.json({ user: toPublicUser(fresh) });
});

app.delete("/api/me", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id),
    c.env.DB.prepare(`DELETE FROM login_tokens WHERE email = ?`).bind(user.email),
    c.env.DB.prepare(
      `UPDATE users
       SET email = ?, username = ?, display_name = 'Deleted user', deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    ).bind(tombstoneEmail(user.id), tombstoneUsername(user.id), now, user.id),
  ]);
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

app.get("/api/users", async (c) => {
  const user = c.get("user");
  const username = normalizeUsername(c.req.query("username"));
  if (!username) return error(c, 400, "invalid_input", "Enter a username.");
  if (!(await allow(c.env.LOOKUP_RATE_LIMITER, `lookup:${user.id}`))) {
    return error(c, 429, "rate_limited", "Too many lookups. Wait a minute and try again.");
  }

  const found = await c.env.DB.prepare(
    `SELECT id, username, display_name, deleted_at FROM users WHERE username = ?`,
  )
    .bind(username)
    .first<{ id: string; username: string; display_name: string; deleted_at: number | null }>();
  if (!found || found.deleted_at || found.id === user.id || (await isBlocked(c.env.DB, user.id, found.id))) {
    return error(c, 404, "not_found", "No user has that username.");
  }
  return c.json({
    user: { id: found.id, username: found.username, displayName: found.display_name },
  });
});

app.get("/api/blocks", async (c) => {
  const user = c.get("user");
  const result = await c.env.DB.prepare(
    `SELECT u.username, u.display_name
     FROM blocks b
     JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ?
     ORDER BY u.username`,
  )
    .bind(user.id)
    .all<{ username: string; display_name: string }>();
  return c.json({
    blocks: result.results.map((row) => ({ username: row.username, displayName: row.display_name })),
  });
});

app.post("/api/blocks", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const body = await readJson(c);
  const username = body ? normalizeUsername(body.username) : null;
  if (!username) return error(c, 400, "invalid_input", "Enter a username.");
  const target = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ? AND deleted_at IS NULL`)
    .bind(username)
    .first<{ id: string }>();
  if (!target || target.id === user.id) return error(c, 404, "not_found", "No user has that username.");
  await c.env.DB.prepare(
    `INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
  )
    .bind(user.id, target.id, Date.now())
    .run();
  return c.json({ ok: true });
});

app.delete("/api/blocks/:username", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const username = normalizeUsername(c.req.param("username"));
  if (!username) return error(c, 400, "invalid_input", "Enter a username.");
  await c.env.DB.prepare(
    `DELETE FROM blocks
     WHERE blocker_id = ?
       AND blocked_id = (SELECT id FROM users WHERE username = ?)`,
  )
    .bind(user.id, username)
    .run();
  return c.json({ ok: true });
});

app.get("/api/conversations", async (c) => {
  const user = c.get("user");
  const conversations = await listConversations(c.env.DB, user.id);
  return c.json({ conversations: await withPresence(c.env, conversations) });
});

app.post("/api/conversations", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const body = await readJson(c);
  const username = body ? normalizeUsername(body.username) : null;
  if (!username) return error(c, 400, "invalid_input", "Enter a username.");
  if (!(await allow(c.env.LOOKUP_RATE_LIMITER, `open:${user.id}`))) {
    return error(c, 429, "rate_limited", "Too many requests. Wait a minute and try again.");
  }

  const other = await c.env.DB.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first<UserRow>();
  if (!other || other.deleted_at || other.id === user.id) {
    return error(c, 404, "not_found", "No user has that username.");
  }
  if (await isBlocked(c.env.DB, user.id, other.id)) {
    return error(c, 403, "blocked", "You cannot message this user.");
  }

  const key = pairKey(user.id, other.id);
  const existing = await c.env.DB.prepare(`SELECT id FROM conversations WHERE dm_pair_key = ?`)
    .bind(key)
    .first<{ id: string }>();
  let conversationId = existing?.id;
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    const now = Date.now();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO conversations (id, type, dm_pair_key, created_at) VALUES (?, 'direct', ?, ?)`,
        ).bind(conversationId, key, now),
        c.env.DB.prepare(
          `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        ).bind(conversationId, user.id, now),
        c.env.DB.prepare(
          `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        ).bind(conversationId, other.id, now),
      ]);
    } catch (error) {
      const raced = await c.env.DB.prepare(`SELECT id FROM conversations WHERE dm_pair_key = ?`)
        .bind(key)
        .first<{ id: string }>();
      if (!raced) throw error;
      conversationId = raced.id;
    }
  }

  const conversation = await getConversation(c.env.DB, user.id, conversationId);
  if (!conversation) return error(c, 500, "missing_conversation", "The conversation could not be opened.");
  const [withPeer] = await withPresence(c.env, [conversation]);
  return c.json({ conversation: withPeer }, existing ? 200 : 201);
});

app.get("/api/conversations/:id", async (c) => {
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  const [withPeer] = await withPresence(c.env, [conversation]);
  return c.json({ conversation: withPeer });
});

app.get("/api/conversations/:id/messages", async (c) => {
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  const before = parseSeq(c.req.query("before_seq"));
  const after = parseSeq(c.req.query("after_seq"));
  if (before === "invalid" || after === "invalid") {
    return error(c, 400, "invalid_input", "Sequence cursors must be positive integers.");
  }
  if (before && after) return error(c, 400, "invalid_input", "Choose one sequence cursor.");
  const page = await listMessages(c.env.DB, conversation.id, {
    beforeSeq: before ?? undefined,
    afterSeq: after ?? undefined,
  });
  return c.json(page);
});

app.post("/api/conversations/:id/attachments", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  if (!(await allow(c.env.SEND_RATE_LIMITER, `send:${user.id}`))) {
    return error(c, 429, "rate_limited", "Too many messages. Wait a minute and try again.");
  }
  if (await isBlocked(c.env.DB, user.id, conversation.peer.id)) {
    return error(c, 403, "blocked", "You cannot message this user.");
  }

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size < 1) return error(c, 400, "invalid_input", "Choose an image.");
  if (file.size > MAX_ATTACHMENT_BYTES) return error(c, 413, "too_large", "Images must be 5 MB or smaller.");
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const contentType = sniffImage(header);
  if (!contentType) return error(c, 400, "invalid_input", "Use a JPEG, PNG, GIF, or WebP image.");

  const id = crypto.randomUUID();
  const key = attachmentKey(conversation.id, id);
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments (id, conversation_id, uploader_id, message_id, r2_key, content_type, byte_size, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
      .bind(id, conversation.id, user.id, key, contentType, file.size, Date.now())
      .run();
  } catch (uploadError) {
    await c.env.MEDIA.delete(key);
    throw uploadError;
  }
  return c.json({ attachment: { id, contentType, byteSize: file.size } }, 201);
});

app.delete("/api/conversations/:id/attachments/:attachmentId", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  const attachmentId = c.req.param("attachmentId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT r2_key FROM attachments
     WHERE id = ? AND conversation_id = ? AND uploader_id = ? AND message_id IS NULL`,
  )
    .bind(attachmentId, conversation.id, user.id)
    .first<{ r2_key: string }>();
  if (!row) return error(c, 404, "not_found", "Image not found.");
  await c.env.DB.prepare(`DELETE FROM attachments WHERE id = ? AND message_id IS NULL`).bind(attachmentId).run();
  await c.env.MEDIA.delete(row.r2_key);
  return c.json({ ok: true });
});

app.get("/api/conversations/:id/attachments/:attachmentId", async (c) => {
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  const attachmentId = c.req.param("attachmentId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT r2_key, content_type, byte_size
     FROM attachments
     WHERE id = ? AND conversation_id = ? AND message_id IS NOT NULL`,
  )
    .bind(attachmentId, conversation.id)
    .first<{ r2_key: string; content_type: string; byte_size: number }>();
  if (!row) return error(c, 404, "not_found", "Image not found.");
  const object = await c.env.MEDIA.get(row.r2_key);
  if (!object) return error(c, 404, "not_found", "Image not found.");
  const headers = new Headers();
  headers.set("content-type", row.content_type);
  headers.set("content-length", String(row.byte_size));
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private");
  return new Response(object.body, { headers });
});

app.post("/api/conversations/:id/messages", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  if (!(await allow(c.env.SEND_RATE_LIMITER, `send:${user.id}`))) {
    return error(c, 429, "rate_limited", "Too many messages. Wait a minute and try again.");
  }
  if (await isBlocked(c.env.DB, user.id, conversation.peer.id)) {
    return error(c, 403, "blocked", "You cannot message this user.");
  }

  const body = await readJson(c);
  const text = body ? normalizeMessageBody(body.body, { allowEmpty: true }) : null;
  const clientMsgId = body ? normalizeClientMessageId(body.clientMsgId) : null;
  const attachmentIds = body ? normalizeAttachmentIds(body.attachmentIds) : null;
  if (!clientMsgId || text === null || attachmentIds === null || (text.length === 0 && attachmentIds.length === 0)) {
    return error(c, 400, "invalid_input", "A message needs text or an image.");
  }

  const inserted = await insertMessage(c.env.DB, {
    conversationId: conversation.id,
    senderId: user.id,
    clientMsgId,
    body: text,
  });
  if (!inserted.replay && attachmentIds.length > 0) {
    const linked = await linkAttachments(c.env.DB, {
      messageId: inserted.message.id,
      conversationId: conversation.id,
      uploaderId: user.id,
      attachmentIds,
    });
    if (!linked) {
      await undoMessageInsert(c.env.DB, conversation.id, inserted.message.id, user.id);
      return error(c, 400, "invalid_input", "Those images are no longer available to send.");
    }
    inserted.message.attachments = linked;
  }
  if (!inserted.replay) {
    try {
      await publishMessage(c.env, conversation.id, inserted.message);
    } catch (error) {
      console.error("message fan-out failed", error);
    }
  }
  return c.json({ message: inserted.message, idempotentReplay: inserted.replay }, inserted.replay ? 200 : 201);
});

app.put("/api/conversations/:id/messages/:messageId/reaction", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  if (!(await allow(c.env.SEND_RATE_LIMITER, `react:${user.id}`))) {
    return error(c, 429, "rate_limited", "Too many reactions. Wait a minute and try again.");
  }
  if (await isBlocked(c.env.DB, user.id, conversation.peer.id)) {
    return error(c, 403, "blocked", "You cannot message this user.");
  }

  const messageId = normalizeUuid(c.req.param("messageId"));
  const body = await readJson(c);
  if (!messageId) return error(c, 400, "invalid_input", "That message does not exist.");
  if (!body || !("emoji" in body)) return error(c, 400, "invalid_input", "Choose a single emoji, or remove your reaction.");
  const emoji = body.emoji === null ? null : normalizeReactionEmoji(body.emoji);
  if (body.emoji !== null && !emoji) return error(c, 400, "invalid_input", "Choose a single emoji.");

  const result = await setMessageReaction(c.env.DB, {
    conversationId: conversation.id,
    messageId,
    userId: user.id,
    emoji,
  });
  if (!result) return error(c, 404, "not_found", "Message not found.");
  if (result.changed) {
    try {
      await publishReaction(c.env, conversation.id, messageId, user.id, emoji);
    } catch (error) {
      console.error("reaction fan-out failed", error);
    }
  }
  return c.json({ reactions: result.reactions });
});

app.post("/api/conversations/:id/read", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  const user = c.get("user");
  const conversation = await requireConversation(c);
  if (conversation instanceof Response) return conversation;
  const body = await readJson(c);
  const seq = body ? parseSeq(body.lastReadSeq) : null;
  if (typeof seq !== "number") return error(c, 400, "invalid_input", "Provide the sequence you have read.");

  const lastReadSeq = await markRead(c.env.DB, conversation.id, user.id, seq);
  if (lastReadSeq === null) return error(c, 404, "not_found", "Conversation not found.");
  try {
    await fanOut(c.env, [user.id, conversation.peer.id], {
      type: "read",
      conversationId: conversation.id,
      userId: user.id,
      lastReadSeq,
    });
  } catch (error) {
    console.error("read fan-out failed", error);
  }
  return c.json({ lastReadSeq });
});

app.get("/api/ws", async (c) => {
  if (!sameOrigin(c.req.raw)) return error(c, 403, "forbidden", "Cross-origin request rejected.");
  if (c.req.header("Upgrade") !== "websocket") return error(c, 426, "upgrade_required", "Expected a WebSocket.");
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (!token) return error(c, 401, "unauthorized", "Sign in to continue.");
  const user = await findUserBySession(c.env.DB, token);
  if (!user) return error(c, 401, "unauthorized", "Sign in to continue.");

  const url = new URL(c.req.url);
  url.pathname = `/hub/${user.id}`;
  return c.env.USER_HUB.getByName(user.id).fetch(new Request(url.toString(), c.req.raw));
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return error(c, 404, "not_found", "Not found.");
  return c.text("Not found", 404);
});

export default app;
export { UserHub };

function isPublicAuth(path: string): boolean {
  return path === "/api/auth/register" || path === "/api/auth/login" || path === "/api/auth/verify";
}

async function sendLink(
  c: AppContext,
  email: string,
  purpose: "login" | "register",
  username: string | null,
  displayName: string | null,
) {
  const recent = await c.env.DB.prepare(
    `SELECT created_at FROM login_tokens WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{ created_at: number }>();
  if (recent && Date.now() - recent.created_at < LOGIN_COOLDOWN_MS) {
    return c.json({ ok: true, message: "Check your email for a sign-in link." });
  }

  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO login_tokens
      (id, email, token_hash, purpose, username, display_name, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      email,
      await sha256(token),
      purpose,
      username,
      displayName,
      now + LOGIN_TOKEN_TTL_MS,
      now,
    )
    .run();

  const link = `${new URL(c.req.url).origin}/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await deliverMagicLink(c.env, email, link);
  } catch (error) {
    if (error instanceof MailDeliveryError) {
      return errorResponse(c, 503, "email_failed", "The email could not be sent. Try again in a minute.");
    }
    throw error;
  }

  return c.json({
    ok: true,
    message: "Check your email for a sign-in link.",
    ...(allowsDevLink(c.req.raw, c.env) ? { devLink: link } : {}),
  });
}

async function createUser(
  db: D1Database,
  email: string,
  username: string,
  displayName: string,
  now: number,
): Promise<UserRow | null> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, username, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, email, username, displayName, now)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return null;
    throw error;
  }
  return db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

function startSession(c: AppContext, user: UserRow, now: number) {
  const token = randomToken();
  const expiresAt = now + SESSION_TTL_MS;
  return sha256(token).then(async (tokenHash) => {
    await c.env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), user.id, tokenHash, expiresAt, now)
      .run();
    c.header("Set-Cookie", sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
    return c.json({ user: toPublicUser(user) });
  });
}

async function requireConversation(c: AppContext) {
  const user = c.get("user");
  if (!user) return error(c, 401, "unauthorized", "Sign in to continue.");
  const conversation = await getConversation(c.env.DB, user.id, c.req.param("id") ?? "");
  if (!conversation) return error(c, 404, "not_found", "Conversation not found.");
  return conversation;
}

async function withPresence(
  env: Env,
  conversations: Awaited<ReturnType<typeof listConversations>>,
): Promise<ConversationDto[]> {
  const results: ConversationDto[] = [];
  for (let index = 0; index < conversations.length; index += 6) {
    const chunk = conversations.slice(index, index + 6);
    const statuses = await Promise.all(
      chunk.map(async (conversation) => {
        try {
          return await env.USER_HUB.getByName(conversation.peer.id).presence();
        } catch (error) {
          console.error("presence lookup failed", error);
          return { online: false };
        }
      }),
    );
    chunk.forEach((conversation, offset) => {
      results.push({ ...conversation, peerOnline: statuses[offset]?.online ?? false });
    });
  }
  return results;
}

function parseSeq(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return "invalid";
  return numeric;
}

async function allow(limiter: RateLimit, key: string): Promise<boolean> {
  const result = await limiter.limit({ key });
  return result.success;
}

async function readJson(c: AppContext): Promise<Record<string, unknown> | null> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function error(c: AppContext, status: 400 | 401 | 403 | 404 | 409 | 413 | 426 | 429 | 500 | 503, code: string, message: string) {
  return errorResponse(c, status, code, message);
}

function errorResponse(
  c: AppContext,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 426 | 429 | 500 | 503,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

