/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ConversationDto, MessageDto } from "../shared/events";
import { openDirectResponse } from "./open-direct";

const origin = "http://localhost";

describe("group-ready groundwork", () => {
  it("numbers messages without gaps or collisions when sent at once", async () => {
    const quin = await register("quin@example.com", "quin", "Quin");
    const remy = await register("remy@example.com", "remy", "Remy");
    const conversationId = await openDirect(quin.cookie, "remy");

    const sends = Array.from({ length: 24 }, (_, index) =>
      send(index % 2 === 0 ? quin.cookie : remy.cookie, `/api/conversations/${conversationId}/messages`, {
        clientMsgId: crypto.randomUUID(),
        body: `burst ${index}`,
      }),
    );
    const responses = await Promise.all(sends);
    expect(responses.map((response) => response.status)).toEqual(Array(24).fill(201));
    const seqs = await Promise.all(responses.map(async (response) => ((await response.json()) as { message: MessageDto }).message.seq));
    expect([...seqs].sort((left, right) => left - right)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));

    // A retried send with the same id is a replay and doesn't use up a number.
    const clientMsgId = crypto.randomUUID();
    const first = await send(quin.cookie, `/api/conversations/${conversationId}/messages`, { clientMsgId, body: "once" });
    const again = await send(quin.cookie, `/api/conversations/${conversationId}/messages`, { clientMsgId, body: "once" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const next = await send(quin.cookie, `/api/conversations/${conversationId}/messages`, { clientMsgId: crypto.randomUUID(), body: "next" });
    expect(((await next.json()) as { message: MessageDto }).message.seq).toBe(26);
  });

  it("keeps numbering ahead of messages written without the counter", async () => {
    const sol = await register("sol@example.com", "sol", "Sol");
    await register("tam@example.com", "tam", "Tam");
    const conversationId = await openDirect(sol.cookie, "tam");
    const senderId = (await env.DB.prepare(`SELECT id FROM users WHERE username = 'sol'`).first<{ id: string }>())?.id;
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, client_msg_id, seq, body, created_at) VALUES (?, ?, ?, ?, 7, 'imported', 1)`,
    )
      .bind(crypto.randomUUID(), conversationId, senderId, crypto.randomUUID())
      .run();
    const posted = await send(sol.cookie, `/api/conversations/${conversationId}/messages`, { clientMsgId: crypto.randomUUID(), body: "after" });
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { message: MessageDto }).message.seq).toBe(8);
  });

  it("lists every member with their read position", async () => {
    const uma = await register("uma@example.com", "uma", "Uma");
    const vic = await register("vic@example.com", "vic", "Vic");
    const conversationId = await openDirect(uma.cookie, "vic");
    await sendMessage(uma.cookie, conversationId, "hello");
    expect((await send(vic.cookie, `/api/conversations/${conversationId}/read`, { lastReadSeq: 1 })).status).toBe(200);

    const listed = (await (await send(uma.cookie, "/api/conversations", undefined, "GET")).json()) as { conversations: ConversationDto[] };
    const conversation = listed.conversations[0];
    expect(conversation?.type).toBe("direct");
    expect(conversation?.title).toBeNull();
    const members = [...(conversation?.members ?? [])].sort((left, right) => left.username.localeCompare(right.username));
    expect(members.map((member) => [member.username, member.lastReadSeq, member.role])).toEqual([
      ["uma", 0, "member"],
      ["vic", 1, "member"],
    ]);
    expect(conversation?.peer.username).toBe("vic");

    const single = (await (await send(vic.cookie, `/api/conversations/${conversationId}`, undefined, "GET")).json()) as { conversation: ConversationDto };
    expect(single.conversation.members).toHaveLength(2);
  });

  it("still delivers live events after replying", async () => {
    const wyn = await register("wyn@example.com", "wyn", "Wyn");
    const xan = await register("xan@example.com", "xan", "Xan");
    const conversationId = await openDirect(wyn.cookie, "xan");
    const wynSocket = await openSocket(wyn.cookie);
    const xanSocket = await openSocket(xan.cookie);
    const message = nextEvent(xanSocket, "message");
    const messageId = await sendMessage(wyn.cookie, conversationId, "live");
    expect(((await message) as { message: { id: string } }).message.id).toBe(messageId);
    const read = nextEvent(wynSocket, "read");
    await send(xan.cookie, `/api/conversations/${conversationId}/read`, { lastReadSeq: 1 });
    expect(await read).toMatchObject({ type: "read", conversationId, lastReadSeq: 1 });
    wynSocket.close();
    xanSocket.close();
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

async function openDirect(cookie: string, username: string): Promise<string> {
  const opened = await openDirectResponse(cookie, username);
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

