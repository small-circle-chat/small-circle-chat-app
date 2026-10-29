/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = "http://localhost";

describe("direct messages", () => {
  it("registers two users, delivers a live message, and keeps history", async () => {
    const ada = await register("ada@example.com", "ada", "Ada Lovelace");
    const alan = await register("alan@example.com", "alan", "Alan Turing");

    const opened = await send(ada.cookie, "/api/conversations", { username: "alan" });
    expect(opened.status).toBe(201);
    const conversationId = ((await opened.json()) as { conversation: { id: string } }).conversation.id;

    const clientMsgId = crypto.randomUUID();
    const alanSocket = await openSocket(alan.cookie);
    const incoming = nextMessage(alanSocket);

    const posted = await send(ada.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId,
      body: "Hello Alan",
    });
    expect(posted.status).toBe(201);
    const stored = ((await posted.json()) as { message: { id: string; seq: number } }).message;

    const event = await incoming;
    expect(event.type).toBe("message");
    if (event.type === "message") expect(event.message?.body).toBe("Hello Alan");

    const replay = await send(ada.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId,
      body: "Hello Alan",
    });
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { idempotentReplay: boolean; message: { id: string } };
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.message.id).toBe(stored.id);

    const outsider = await register("grace@example.com", "grace", "Grace Hopper");
    const forbidden = await send(outsider.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId: crypto.randomUUID(),
      body: "I should not be here",
    });
    expect(forbidden.status).toBe(404);

    const history = await send(alan.cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
    const body = (await history.json()) as { messages: Array<{ id: string; seq: number }>; hasMore: boolean };
    expect(body.messages.map((message) => message.id)).toEqual([stored.id]);
    expect(body.messages[0]?.seq).toBe(stored.seq);
    expect(body.hasMore).toBe(false);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM messages`).first<{ count: number }>();
    expect(count?.count).toBe(1);
    alanSocket.close();
  });

  it("keeps an image inside the conversation", async () => {
    const ada = await register("ada@example.com", "ada", "Ada Lovelace");
    const alan = await register("alan@example.com", "alan", "Alan Turing");
    const grace = await register("grace@example.com", "grace", "Grace Hopper");
    const opened = await send(ada.cookie, "/api/conversations", { username: "alan" });
    const conversationId = ((await opened.json()) as { conversation: { id: string } }).conversation.id;
    const other = await send(ada.cookie, "/api/conversations", { username: "grace" });
    const otherId = ((await other.json()) as { conversation: { id: string } }).conversation.id;

    const rejected = await upload(ada.cookie, conversationId, new TextEncoder().encode("<svg></svg>"), "x.svg", "image/svg+xml");
    expect(rejected.status).toBe(400);

    const uploaded = await upload(ada.cookie, conversationId, PNG, "pixel.png", "image/png");
    expect(uploaded.status).toBe(201);
    const attachmentId = ((await uploaded.json()) as { attachment: { id: string } }).attachment.id;

    expect((await fetchImage(null, conversationId, attachmentId)).status).toBe(401);
    expect((await fetchImage(ada.cookie, conversationId, attachmentId)).status).toBe(404);
    expect((await fetchImage(alan.cookie, conversationId, attachmentId)).status).toBe(404);
    expect((await fetchImage(grace.cookie, conversationId, attachmentId)).status).toBe(404);

    const alanSocket = await openSocket(alan.cookie);
    const incoming = nextMessage(alanSocket);
    const clientMsgId = crypto.randomUUID();
    const posted = await send(ada.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId,
      body: "",
      attachmentIds: [attachmentId],
    });
    expect(posted.status).toBe(201);
    const message = ((await posted.json()) as { message: { id: string; attachments: Array<{ id: string }> } }).message;
    expect(message.attachments.map((item) => item.id)).toEqual([attachmentId]);

    const event = await incoming;
    expect(event.type).toBe("message");
    if (event.type === "message") expect(event.message?.attachments?.[0]?.id).toBe(attachmentId);

    const image = await fetchImage(alan.cookie, conversationId, attachmentId);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("private");
    expect(image.headers.get("access-control-allow-origin")).toBeNull();
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);

    expect((await fetchImage(grace.cookie, otherId, attachmentId)).status).toBe(404);
    expect((await fetchImage(alan.cookie, otherId, attachmentId)).status).toBe(404);

    const replay = await send(ada.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId,
      body: "",
      attachmentIds: [attachmentId],
    });
    expect(replay.status).toBe(200);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE message_id IS NOT NULL`).first<{ count: number }>();
    expect(rows?.count).toBe(1);

    const inbox = await send(alan.cookie, "/api/conversations", undefined, "GET");
    const preview = ((await inbox.json()) as { conversations: Array<{ lastMessagePreview: string | null }> }).conversations[0];
    expect(preview?.lastMessagePreview).toBe("Photo");
    alanSocket.close();
  });

  it("renames a user and shows the new name in the other inbox", async () => {
    const ada = await register("ada@example.com", "ada", "Ada Lovelace");
    const alan = await register("alan@example.com", "alan", "Alan Turing");
    expect((await send(ada.cookie, "/api/conversations", { username: "alan" })).status).toBe(201);

    const invalid = await send(ada.cookie, "/api/me", { username: "Ada Lovelace" }, "PATCH");
    expect(invalid.status).toBe(400);

    const taken = await send(ada.cookie, "/api/me", { username: "alan", displayName: "Augusta Ada" }, "PATCH");
    expect(taken.status).toBe(409);

    const renamed = await send(ada.cookie, "/api/me", { username: "augusta", displayName: "Augusta Ada" }, "PATCH");
    expect(renamed.status).toBe(200);
    const user = ((await renamed.json()) as { user: { username: string; displayName: string } }).user;
    expect(user).toMatchObject({ username: "augusta", displayName: "Augusta Ada" });

    const inbox = await send(alan.cookie, "/api/conversations", undefined, "GET");
    const peer = ((await inbox.json()) as { conversations: Array<{ peer: { username: string; displayName: string } }> })
      .conversations[0]?.peer;
    expect(peer).toMatchObject({ username: "augusta", displayName: "Augusta Ada" });

    const released = await register("byron@example.com", "ada", "Annabella");
    const found = await send(alan.cookie, "/api/users?username=ada", undefined, "GET");
    expect(found.status).toBe(200);
    const owner = ((await found.json()) as { user: { displayName: string } }).user;
    expect(owner.displayName).toBe("Annabella");
    expect(released.cookie).toContain("__Host-session=");
  });

  it("reports another page from one extra row, including when sequence numbers skip", async () => {
    const ada = await register("ada@example.com", "ada", "Ada Lovelace");
    const alan = await register("alan@example.com", "alan", "Alan Turing");
    const opened = await send(ada.cookie, "/api/conversations", { username: "alan" });
    const conversationId = ((await opened.json()) as { conversation: { id: string } }).conversation.id;
    const profile = await send(ada.cookie, "/api/me", undefined, "GET");
    const senderId = ((await profile.json()) as { user: { id: string } }).user.id;

    await insertMessages(conversationId, senderId, 51);
    const latest = await send(alan.cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
    const page = (await latest.json()) as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((message) => message.seq)).toEqual(range(2, 51));

    const older = await send(
      alan.cookie,
      `/api/conversations/${conversationId}/messages?before_seq=${page.messages[0]?.seq}`,
      undefined,
      "GET",
    );
    const rest = (await older.json()) as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(rest.hasMore).toBe(false);
    expect(rest.messages.map((message) => message.seq)).toEqual([1]);

    await env.DB.prepare(`DELETE FROM messages WHERE conversation_id = ? AND seq = 1`).bind(conversationId).run();
    const gapped = await send(alan.cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
    const gap = (await gapped.json()) as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(gap.hasMore).toBe(false);
    expect(gap.messages).toHaveLength(50);
    expect(gap.messages[0]?.seq).toBe(2);
  });
});

async function insertMessages(conversationId: string, senderId: string, count: number): Promise<void> {
  const statements = [];
  for (let seq = 1; seq <= count; seq += 1) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_id, client_msg_id, seq, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), conversationId, senderId, crypto.randomUUID(), seq, `message ${seq}`, seq),
    );
  }
  await env.DB.batch(statements);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function upload(cookie: string, conversationId: string, bytes: Uint8Array, name: string, type: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return SELF.fetch(`${origin}/api/conversations/${conversationId}/attachments`, {
    method: "POST",
    headers: { origin, cookie: cookie.split(";")[0] ?? cookie },
    body: form,
  });
}

async function fetchImage(cookie: string | null, conversationId: string, attachmentId: string): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie.split(";")[0] ?? cookie);
  return SELF.fetch(`${origin}/api/conversations/${conversationId}/attachments/${attachmentId}`, { headers });
}

async function register(email: string, username: string, displayName: string): Promise<{ cookie: string }> {
  const requested = await send(null, "/api/auth/register", { email, username, displayName });
  expect(requested.status).toBe(200);
  const link = ((await requested.json()) as { devLink?: string }).devLink;
  expect(link).toBeTruthy();
  const token = new URL(link ?? "").searchParams.get("token");
  const verified = await send(null, "/api/auth/verify", { token });
  expect(verified.status).toBe(200);
  const cookie = verified.headers.get("Set-Cookie");
  expect(cookie).toContain("__Host-session=");
  return { cookie: cookie ?? "" };
}

async function send(cookie: string | null, path: string, body?: unknown, method = "POST"): Promise<Response> {
  const headers = new Headers({ origin });
  if (cookie) headers.set("cookie", cookie.split(";")[0] ?? cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function openSocket(cookie: string): Promise<WebSocket> {
  const response = await SELF.fetch(`${origin}/api/ws`, {
    headers: {
      origin,
      upgrade: "websocket",
      cookie: cookie.split(";")[0] ?? cookie,
    },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("WebSocket upgrade failed");
  socket.accept();
  return socket;
}

function nextMessage(socket: WebSocket): Promise<{ type: string; message?: { body: string; attachments?: Array<{ id: string }> } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for a socket message")), 5000);
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as { type: string; message?: { body: string; attachments?: Array<{ id: string }> } };
      if (payload.type !== "message") return;
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}
