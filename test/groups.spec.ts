/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ConversationDto, MessageDto } from "../shared/events";
import { openDirectResponse } from "./open-direct";

const origin = "http://localhost";

describe("group chats", () => {
  it("creates a group from people you already chat with and delivers to everyone", async () => {
    const ann = await register("ann@example.com", "ann", "Ann");
    const bo = await register("bob@example.com", "bob", "Bob");
    const cy = await register("cyd@example.com", "cyd", "Cyd");
    await openDirect(ann.cookie, "bob");
    await openDirect(ann.cookie, "cyd");
    const [boId, cyId, annId] = await Promise.all([userId(bo.cookie), userId(cy.cookie), userId(ann.cookie)]);

    const boSocket = await openSocket(bo.cookie);
    const opened = nextEvent(boSocket, "conversation_opened");
    const created = await send(ann.cookie, "/api/groups", { title: "  Book   club ", memberIds: [boId, cyId, annId] });
    expect(created.status).toBe(201);
    const group = ((await created.json()) as { conversation: ConversationDto }).conversation;
    expect(group).toMatchObject({ type: "group", title: "Book club", peer: null, peerOnline: false });
    expect(Object.fromEntries(group.members.map((member) => [member.username, member.role]))).toEqual({ ann: "owner", bob: "member", cyd: "member" });
    expect(await opened).toEqual({ type: "conversation_opened", conversationId: group.id });

    // Everyone sees it in their list, next to their one-to-one chats.
    const cyList = (await (await send(cy.cookie, "/api/conversations", undefined, "GET")).json()) as { conversations: ConversationDto[] };
    expect(cyList.conversations.map((conversation) => conversation.type).sort()).toEqual(["direct", "group"]);

    const message = nextEvent(boSocket, "message");
    const posted = await send(cy.cookie, `/api/conversations/${group.id}/messages`, { clientMsgId: crypto.randomUUID(), body: "hi all" });
    expect(posted.status).toBe(201);
    expect(((await message) as { message: MessageDto }).message.body).toBe("hi all");

    const read = nextEvent(boSocket, "read");
    await send(ann.cookie, `/api/conversations/${group.id}/read`, { lastReadSeq: 1 });
    expect(await read).toMatchObject({ type: "read", conversationId: group.id, userId: annId, lastReadSeq: 1 });
    const summary = (await (await send(bo.cookie, `/api/conversations/${group.id}`, undefined, "GET")).json()) as { conversation: ConversationDto };
    expect(summary.conversation.unreadCount).toBe(1);
    expect(summary.conversation.lastMessageSenderId).toBe(cyId);
    expect(summary.conversation.members.find((member) => member.id === annId)?.lastReadSeq).toBe(1);
    boSocket.close();
  });

  it("only lets you add people you already chat with, up to 25 in all", async () => {
    const dot = await register("dot@example.com", "dot", "Dot");
    const eli = await register("eli@example.com", "eli", "Eli");
    const fox = await register("fox@example.com", "fox", "Fox");
    const gem = await register("gem@example.com", "gem", "Gem");
    await openDirect(dot.cookie, "eli");
    await openDirect(dot.cookie, "fox");
    const [eliId, foxId, gemId] = await Promise.all([userId(eli.cookie), userId(fox.cookie), userId(gem.cookie)]);

    expect((await send(dot.cookie, "/api/groups", { memberIds: [eliId] })).status).toBe(400);
    expect((await send(dot.cookie, "/api/groups", { memberIds: [eliId, gemId] })).status).toBe(403);
    const tooMany = Array.from({ length: 25 }, () => crypto.randomUUID());
    expect((await send(dot.cookie, "/api/groups", { memberIds: tooMany })).status).toBe(400);
    expect((await send(dot.cookie, "/api/groups", { memberIds: [eliId, foxId], title: "x".repeat(61) })).status).toBe(400);

    expect((await send(fox.cookie, "/api/blocks", { username: "dot" })).status).toBe(200);
    expect((await send(dot.cookie, "/api/groups", { memberIds: [eliId, foxId] })).status).toBe(403);
    expect((await send(eli.cookie, "/api/conversations", undefined, "GET")).status).toBe(200);
  });

  it("lets members leave, hands over ownership, and ignores blocks between other members", async () => {
    const hal = await register("hal@example.com", "hal", "Hal");
    const ida = await register("ida@example.com", "ida", "Ida");
    const jon = await register("jon@example.com", "jon", "Jon");
    const halDirect = await openDirect(hal.cookie, "ida");
    await openDirect(hal.cookie, "jon");
    const [idaId, jonId] = await Promise.all([userId(ida.cookie), userId(jon.cookie)]);
    const created = await send(hal.cookie, "/api/groups", { memberIds: [idaId, jonId] });
    const group = ((await created.json()) as { conversation: ConversationDto }).conversation;
    expect(group.title).toBeNull();

    // Jon blocking Ida doesn't stop either of them talking in the group.
    expect((await send(jon.cookie, "/api/blocks", { username: "ida" })).status).toBe(200);
    expect((await send(ida.cookie, `/api/conversations/${group.id}/messages`, { clientMsgId: crypto.randomUUID(), body: "still here" })).status).toBe(201);

    expect((await send(hal.cookie, `/api/conversations/${halDirect}/leave`)).status).toBe(400);

    const jonSocket = await openSocket(jon.cookie);
    const updated = nextEvent(jonSocket, "conversation_updated");
    expect((await send(hal.cookie, `/api/conversations/${group.id}/leave`)).status).toBe(200);
    expect(await updated).toEqual({ type: "conversation_updated", conversationId: group.id });
    expect((await send(hal.cookie, `/api/conversations/${group.id}`, undefined, "GET")).status).toBe(404);
    expect((await send(hal.cookie, `/api/conversations/${group.id}/messages`, undefined, "GET")).status).toBe(404);

    const after = (await (await send(jon.cookie, `/api/conversations/${group.id}`, undefined, "GET")).json()) as { conversation: ConversationDto };
    expect(after.conversation.members).toHaveLength(2);
    expect(after.conversation.members.filter((member) => member.role === "owner")).toHaveLength(1);
    jonSocket.close();
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

