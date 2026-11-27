/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MessageDto } from "../shared/events";

const origin = "http://localhost";

describe("message deletion", () => {
  it("lets the sender delete a message for everyone", async () => {
    const dana = await register("dana@example.com", "dana", "Dana");
    const eli = await register("eli@example.com", "eli", "Eli");
    const conversationId = await openDirect(dana.cookie, "eli");
    await sendMessage(dana.cookie, conversationId, "First");
    const secondId = await sendMessage(dana.cookie, conversationId, "Second, oops");

    expect((await conversationSummary(eli.cookie, conversationId)).unreadCount).toBe(2);
    const reacted = await send(eli.cookie, `/api/conversations/${conversationId}/messages/${secondId}/reaction`, { emoji: "\u{1F44D}" }, "PUT");
    expect(reacted.status).toBe(200);

    // Only the sender can delete.
    const notMine = await send(eli.cookie, `/api/conversations/${conversationId}/messages/${secondId}`, undefined, "DELETE");
    expect(notMine.status).toBe(403);

    const eliSocket = await openSocket(eli.cookie);
    const danaSocket = await openSocket(dana.cookie);
    const eliEvent = nextEvent(eliSocket, "message_deleted");
    const danaEvent = nextEvent(danaSocket, "message_deleted");
    const deleted = await send(dana.cookie, `/api/conversations/${conversationId}/messages/${secondId}`, undefined, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await eliEvent).toEqual({ type: "message_deleted", conversationId, messageId: secondId });
    expect(await danaEvent).toEqual({ type: "message_deleted", conversationId, messageId: secondId });

    for (const cookie of [dana.cookie, eli.cookie]) {
      const listed = await send(cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
      const page = (await listed.json()) as { messages: MessageDto[] };
      const tombstone = page.messages.find((message) => message.id === secondId);
      expect(tombstone?.body).toBe("");
      expect(tombstone?.deletedAt).toEqual(expect.any(Number));
      expect(tombstone?.reactions).toEqual([]);
      expect(page.messages.map((message) => message.seq)).toEqual([1, 2]);
    }

    const summary = await conversationSummary(eli.cookie, conversationId);
    expect(summary.unreadCount).toBe(1);
    expect(summary.lastMessagePreview).toBe("First");
    expect(summary.lastMessageSeq).toBe(2);

    // Reacting to a deleted message fails; deleting again is a no-op.
    const lateReaction = await send(eli.cookie, `/api/conversations/${conversationId}/messages/${secondId}/reaction`, { emoji: "\u{1F44D}" }, "PUT");
    expect(lateReaction.status).toBe(404);
    const again = await send(dana.cookie, `/api/conversations/${conversationId}/messages/${secondId}`, undefined, "DELETE");
    expect(again.status).toBe(200);

    // Reading after a deletion counts only live messages, and new messages keep a fresh seq.
    const read = await send(eli.cookie, `/api/conversations/${conversationId}/read`, { lastReadSeq: 1 });
    expect(read.status).toBe(200);
    expect((await conversationSummary(eli.cookie, conversationId)).unreadCount).toBe(0);
    const thirdId = await sendMessage(dana.cookie, conversationId, "Third");
    const after = await send(eli.cookie, `/api/conversations/${conversationId}/messages?after_seq=2`, undefined, "GET");
    const newer = (await after.json()) as { messages: MessageDto[] };
    expect(newer.messages.map((message) => [message.id, message.seq])).toEqual([[thirdId, 3]]);
    eliSocket.close();
    danaSocket.close();
  });

  it("removes a deleted message's images", async () => {
    const fay = await register("fay@example.com", "fay", "Fay");
    const gil = await register("gil@example.com", "gil", "Gil");
    const conversationId = await openDirect(fay.cookie, "gil");
    const uploaded = await upload(fay.cookie, conversationId, PNG, "dot.png", "image/png");
    const attachmentId = ((await uploaded.json()) as { attachment: { id: string } }).attachment.id;
    const posted = await send(fay.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId: crypto.randomUUID(),
      body: "",
      attachmentIds: [attachmentId],
    });
    const messageId = ((await posted.json()) as { message: { id: string } }).message.id;
    const before = await fetchImage(gil.cookie, conversationId, attachmentId);
    expect(before.status).toBe(200);
    await before.arrayBuffer();

    const deleted = await send(fay.cookie, `/api/conversations/${conversationId}/messages/${messageId}`, undefined, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await env.MEDIA.head(`conversations/${conversationId}/${attachmentId}`)).toBeNull();
    expect((await fetchImage(gil.cookie, conversationId, attachmentId)).status).toBe(404);
    expect((await conversationSummary(gil.cookie, conversationId)).lastMessagePreview).toBeNull();
  });

  it("does not delete messages from other conversations", async () => {
    const hal = await register("hal@example.com", "hal", "Hal");
    await register("ivy@example.com", "ivy", "Ivy");
    await register("joan@example.com", "joan", "Joan");
    const withIvy = await openDirect(hal.cookie, "ivy");
    const withJo = await openDirect(hal.cookie, "joan");
    const messageId = await sendMessage(hal.cookie, withIvy, "Hi Ivy");
    const wrong = await send(hal.cookie, `/api/conversations/${withJo}/messages/${messageId}`, undefined, "DELETE");
    expect(wrong.status).toBe(404);
  });
});

function nextEvent(socket: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, 5000);
    const onMessage = (event: MessageEvent) => {
      const payload = JSON.parse(String(event.data)) as { type?: string };
      if (payload.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(payload);
    };
    socket.addEventListener("message", onMessage);
  });
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

async function conversationSummary(
  cookie: string,
  conversationId: string,
): Promise<{ lastMessagePreview: string | null; lastMessageSeq: number; unreadCount: number }> {
  const response = await send(cookie, `/api/conversations/${conversationId}`, undefined, "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { conversation: { lastMessagePreview: string | null; lastMessageSeq: number; unreadCount: number } })
    .conversation;
}

async function openDirect(cookie: string, username: string): Promise<string> {
  const opened = await send(cookie, "/api/conversations", { username });
  expect(opened.status).toBe(201);
  return ((await opened.json()) as { conversation: { id: string } }).conversation.id;
}

async function sendMessage(cookie: string, conversationId: string, body: string): Promise<string> {
  const posted = await send(cookie, `/api/conversations/${conversationId}/messages`, {
    clientMsgId: crypto.randomUUID(),
    body,
  });
  expect(posted.status).toBe(201);
  return ((await posted.json()) as { message: { id: string } }).message.id;
}

async function userId(cookie: string): Promise<string> {
  const profile = await send(cookie, "/api/me", undefined, "GET");
  expect(profile.status).toBe(200);
  return ((await profile.json()) as { user: { id: string } }).user.id;
}

async function react(
  cookie: string,
  conversationId: string,
  messageId: string,
  emoji: string | null,
): Promise<Response> {
  return send(cookie, `/api/conversations/${conversationId}/messages/${messageId}/reaction`, { emoji }, "PUT");
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

