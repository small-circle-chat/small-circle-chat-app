/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ReactionGroup } from "../shared/events";

const origin = "http://localhost";
const heart = "\u2764\uFE0F";
const thumb = "\u{1F44D}";
const fox = "\u{1F98A}";

describe("reactions", () => {
  it("sets, replaces, and removes one reaction per person", async () => {
    const rita = await register("rita@example.com", "rita", "Rita");
    const ruth = await register("ruth@example.com", "ruth", "Ruth");
    const ritaId = await userId(rita.cookie);
    const ruthId = await userId(ruth.cookie);
    const conversationId = await openDirect(rita.cookie, "ruth");
    const messageId = await sendMessage(rita.cookie, conversationId, "Hello Ruth");

    const posted = await send(rita.cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
    const history = (await posted.json()) as { messages: Array<{ id: string; reactions: ReactionGroup[] }> };
    expect(history.messages.find((message) => message.id === messageId)?.reactions).toEqual([]);

    const before = await conversationSummary(rita.cookie, conversationId);
    const ruthSocket = await openSocket(ruth.cookie);
    const heartEvent = nextReaction(ruthSocket);

    const added = await react(rita.cookie, conversationId, messageId, "\u2764");
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ reactions: [{ emoji: heart, userIds: [ritaId] }] });
    expect(await heartEvent).toEqual({
      type: "reaction",
      conversationId,
      messageId,
      userId: ritaId,
      emoji: heart,
    });

    const duplicate = collectReactions(ruthSocket);
    const again = await react(rita.cookie, conversationId, messageId, heart);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ reactions: [{ emoji: heart, userIds: [ritaId] }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(duplicate()).toEqual([]);

    const after = await conversationSummary(rita.cookie, conversationId);
    expect(after.lastMessagePreview).toBe(before.lastMessagePreview);
    expect(after.lastMessageSeq).toBe(before.lastMessageSeq);
    expect(after.unreadCount).toBe(before.unreadCount);

    const replacedEvent = nextReaction(ruthSocket);
    const replaced = await react(rita.cookie, conversationId, messageId, thumb);
    expect(await replaced.json()).toEqual({ reactions: [{ emoji: thumb, userIds: [ritaId] }] });
    expect((await replacedEvent).emoji).toBe(thumb);

    const foxReaction = await react(ruth.cookie, conversationId, messageId, fox);
    expect(foxReaction.status).toBe(200);
    const listed = await send(rita.cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
    const page = (await listed.json()) as { messages: Array<{ id: string; reactions: ReactionGroup[] }> };
    expect(page.messages.find((message) => message.id === messageId)?.reactions).toEqual([
      { emoji: thumb, userIds: [ritaId] },
      { emoji: fox, userIds: [ruthId] },
    ]);

    const joined = await react(rita.cookie, conversationId, messageId, fox);
    expect(await joined.json()).toEqual({ reactions: [{ emoji: fox, userIds: [ruthId, ritaId] }] });

    const removedEvent = nextReaction(ruthSocket);
    const removed = await react(rita.cookie, conversationId, messageId, null);
    expect(await removed.json()).toEqual({ reactions: [{ emoji: fox, userIds: [ruthId] }] });
    expect((await removedEvent).emoji).toBeNull();

    const accepted: Array<[string, string]> = [
      ["\u2764\uFE0E", heart],
      ["\u{1F44D}\uFE0F", thumb],
      ["\u203C", "\u203C\uFE0F"],
      ["1\u20E3", "1\uFE0F\u20E3"],
      ["\u{1F1FA}\u{1F1F8}", "\u{1F1FA}\u{1F1F8}"],
      ["\u{1F468}\u200D\u{1F4BB}", "\u{1F468}\u200D\u{1F4BB}"],
      ["\u{1F44D}\u{1F3FB}", "\u{1F44D}\u{1F3FB}"],
    ];
    for (const [input, canonical] of accepted) {
      const response = await react(rita.cookie, conversationId, messageId, input);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { reactions: ReactionGroup[] };
      expect(body.reactions.find((group) => group.userIds.includes(ritaId))?.emoji).toBe(canonical);
    }
  });

  it("rejects text, outsiders, and blocked members", async () => {
    const nova = await register("nova@example.com", "nova", "Nova");
    const niels = await register("niels@example.com", "niels", "Niels");
    const nell = await register("nell@example.com", "nell", "Nell");
    const conversationId = await openDirect(nova.cookie, "niels");
    const messageId = await sendMessage(nova.cookie, conversationId, "Hello Niels");

    const text = await react(nova.cookie, conversationId, messageId, "hello");
    expect(text.status).toBe(400);
    const several = await react(nova.cookie, conversationId, messageId, `${thumb}${heart}`);
    expect(several.status).toBe(400);
    const empty = await react(nova.cookie, conversationId, messageId, "   ");
    expect(empty.status).toBe(400);
    const missing = await send(nova.cookie, `/api/conversations/${conversationId}/messages/${messageId}/reaction`, {}, "PUT");
    expect(missing.status).toBe(400);
    const numeric = await send(
      nova.cookie,
      `/api/conversations/${conversationId}/messages/${messageId}/reaction`,
      { emoji: 1 },
      "PUT",
    );
    expect(numeric.status).toBe(400);

    const outsider = await react(nell.cookie, conversationId, messageId, thumb);
    expect(outsider.status).toBe(404);
    const absent = await react(nova.cookie, conversationId, crypto.randomUUID(), thumb);
    expect(absent.status).toBe(404);

    const blocked = await send(nova.cookie, "/api/blocks", { username: "niels" });
    expect(blocked.status).toBe(200);
    const denied = await react(niels.cookie, conversationId, messageId, fox);
    expect(denied.status).toBe(403);

    const stored = await env.DB.prepare(`SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?`)
      .bind(messageId)
      .first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });
});

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
  const message = ((await posted.json()) as { message: { id: string; reactions: ReactionGroup[] } }).message;
  expect(message.reactions).toEqual([]);
  return message.id;
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

type ReactionEvent = {
  type: string;
  conversationId: string;
  messageId: string;
  userId: string;
  emoji: string | null;
};

function nextReaction(socket: WebSocket): Promise<ReactionEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for a reaction"));
    }, 5000);
    const onMessage = (event: MessageEvent) => {
      const payload = JSON.parse(String(event.data)) as { type?: string };
      if (payload.type !== "reaction") return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(payload as ReactionEvent);
    };
    socket.addEventListener("message", onMessage);
  });
}

function collectReactions(socket: WebSocket): () => ReactionEvent[] {
  const found: ReactionEvent[] = [];
  const onMessage = (event: MessageEvent) => {
    const payload = JSON.parse(String(event.data)) as { type?: string };
    if (payload.type !== "reaction") return;
    found.push(payload as ReactionEvent);
  };
  socket.addEventListener("message", onMessage);
  return () => {
    socket.removeEventListener("message", onMessage);
    return found;
  };
}
