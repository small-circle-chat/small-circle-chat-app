/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ConversationDto, MessageDto } from "../shared/events";
import { openDirectResponse } from "./open-direct";

const origin = "http://localhost";

describe("running groups", () => {
  it("lets only the owner and admins manage the group, and records each change", async () => {
    const own = await register("own@example.com", "owner1", "Olive");
    const adm = await register("adm@example.com", "admin1", "Adam");
    const mem = await register("mem@example.com", "member1", "Mia");
    await openDirect(own.cookie, "admin1");
    await openDirect(own.cookie, "member1");
    const [admId, memId, ownId] = await Promise.all([userId(adm.cookie), userId(mem.cookie), userId(own.cookie)]);
    const group = await createGroup(own.cookie, [admId, memId]);

    expect((await send(mem.cookie, `/api/groups/${group}`, { title: "Nope" }, "PATCH")).status).toBe(403);
    expect((await send(adm.cookie, `/api/groups/${group}/members/${memId}`, undefined, "DELETE")).status).toBe(403);
    expect((await send(mem.cookie, `/api/groups/${group}/invite`, undefined, "GET")).status).toBe(403);
    expect((await send(adm.cookie, `/api/groups/${group}/members/${memId}/role`, { role: "admin" }, "PUT")).status).toBe(403);

    expect((await send(own.cookie, `/api/groups/${group}/members/${admId}/role`, { role: "admin" }, "PUT")).status).toBe(200);
    const renamed = await send(adm.cookie, `/api/groups/${group}`, { title: "Trip" }, "PATCH");
    expect(((await renamed.json()) as { conversation: ConversationDto }).conversation.title).toBe("Trip");
    // Admins can't remove the owner; they can remove members.
    expect((await send(adm.cookie, `/api/groups/${group}/members/${ownId}`, undefined, "DELETE")).status).toBe(403);
    expect((await send(mem.cookie, `/api/conversations/${group}/messages`, { clientMsgId: crypto.randomUUID(), body: "bye for now" })).status).toBe(201);
    expect((await send(adm.cookie, `/api/groups/${group}/members/${memId}`, undefined, "DELETE")).status).toBe(200);
    expect((await send(mem.cookie, `/api/conversations/${group}`, undefined, "GET")).status).toBe(404);

    const lines = (await messages(own.cookie, group)).filter((message) => message.kind === "system").map((message) => message.body);
    expect(lines).toEqual(["Olive created the group", "Olive made Adam an admin", "Adam named the group \u201cTrip\u201d", "Adam removed Mia"]);

    // Mia's message keeps her name even though she's gone.
    const detail = (await (await send(own.cookie, `/api/conversations/${group}`, undefined, "GET")).json()) as { conversation: ConversationDto };
    expect(detail.conversation.formerMembers.map((member) => member.displayName)).toEqual(["Mia"]);
    expect(detail.conversation.lastMessageKind).toBe("system");
    // System lines can't be reacted to or deleted, and never count as unread.
    const systemId = (await messages(own.cookie, group)).find((message) => message.kind === "system")?.id;
    expect((await send(own.cookie, `/api/conversations/${group}/messages/${systemId}/reaction`, { emoji: "\u{1F44D}" }, "PUT")).status).toBe(404);
    expect((await send(own.cookie, `/api/conversations/${group}/messages/${systemId}`, undefined, "DELETE")).status).toBe(404);
    const admView = (await (await send(adm.cookie, `/api/conversations/${group}`, undefined, "GET")).json()) as { conversation: ConversationDto };
    expect(admView.conversation.unreadCount).toBe(1);
  });

  it("adds contacts who see history from when they join", async () => {
    const pat = await register("pat@example.com", "patty", "Pat");
    const que = await register("que@example.com", "queen", "Que");
    const ray = await register("ray@example.com", "rayray", "Ray");
    const sue = await register("sue@example.com", "suesue", "Sue");
    await register("tim@example.com", "timtim", "Tim");
    await openDirect(pat.cookie, "queen");
    await openDirect(pat.cookie, "rayray");
    await openDirect(pat.cookie, "suesue");
    const [queId, rayId, sueId, timId] = await Promise.all([
      userId(que.cookie),
      userId(ray.cookie),
      userId(sue.cookie),
      env.DB.prepare(`SELECT id FROM users WHERE username = 'timtim'`).first<{ id: string }>().then((row) => row?.id ?? ""),
    ]);
    const group = await createGroup(pat.cookie, [queId, rayId]);
    await send(que.cookie, `/api/conversations/${group}/messages`, { clientMsgId: crypto.randomUUID(), body: "before sue" });

    expect((await send(pat.cookie, `/api/groups/${group}/members`, { memberIds: [timId] })).status).toBe(403);
    const sueSocket = await openSocket(sue.cookie);
    const updated = nextEvent(sueSocket, "conversation_updated");
    const added = await send(pat.cookie, `/api/groups/${group}/members`, { memberIds: [sueId, queId] });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { conversation: ConversationDto }).conversation.members).toHaveLength(4);
    await updated;
    sueSocket.close();

    const seen = await messages(sue.cookie, group);
    expect(seen.map((message) => message.body)).toEqual(["Pat added Sue"]);
    const sueView = (await (await send(sue.cookie, `/api/conversations/${group}`, undefined, "GET")).json()) as { conversation: ConversationDto };
    expect(sueView.conversation.unreadCount).toBe(0);
    await send(ray.cookie, `/api/conversations/${group}/messages`, { clientMsgId: crypto.randomUUID(), body: "welcome sue" });
    expect((await messages(sue.cookie, group)).map((message) => message.body)).toEqual(["Pat added Sue", "welcome sue"]);
  });

  it("lets anyone with the group link join, until it's reset or the group is full", async () => {
    const uli = await register("uli@example.com", "ulrich", "Uli");
    const val = await register("val@example.com", "valval", "Val");
    const wes = await register("wes@example.com", "weswes", "Wes");
    const xia = await register("xia@example.com", "xiaxia", "Xia");
    await openDirect(uli.cookie, "valval");
    await openDirect(uli.cookie, "weswes");
    const group = await createGroup(uli.cookie, [await userId(val.cookie), await userId(wes.cookie)]);

    const token = ((await (await send(uli.cookie, `/api/groups/${group}/invite`, undefined, "GET")).json()) as { token: string }).token;
    expect(((await (await send(uli.cookie, `/api/groups/${group}/invite`, undefined, "GET")).json()) as { token: string }).token).toBe(token);
    const joined = await send(xia.cookie, "/api/invite/redeem", { token });
    expect(joined.status).toBe(201);
    expect(((await joined.json()) as { conversation: ConversationDto }).conversation.id).toBe(group);
    expect((await send(xia.cookie, "/api/invite/redeem", { token })).status).toBe(200);
    expect((await messages(xia.cookie, group)).map((message) => message.body)).toEqual(["Xia joined with the group's invite link"]);

    const reset = ((await (await send(uli.cookie, `/api/groups/${group}/invite/reset`)).json()) as { token: string }).token;
    const yan = await register("yan@example.com", "yanyan", "Yan");
    expect((await send(yan.cookie, "/api/invite/redeem", { token })).status).toBe(404);

    // Fill the group to 25 straight in the database, then the link refuses a 26th.
    const now = Date.now();
    const fillers = Array.from({ length: 21 }, (_, index) => ({ id: crypto.randomUUID(), name: `filler${index}` }));
    await env.DB.batch([
      ...fillers.map((filler) =>
        env.DB.prepare(`INSERT INTO users (id, email, username, display_name, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
          filler.id,
          `${filler.name}@example.com`,
          filler.name,
          filler.name,
          now,
        ),
      ),
      ...fillers.map((filler) =>
        env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).bind(group, filler.id, now),
      ),
    ]);
    const full = await send(yan.cookie, "/api/invite/redeem", { token: reset });
    expect(full.status).toBe(409);
    await expect(
      env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) SELECT ?, id, 'member', ? FROM users WHERE username = 'yanyan'`)
        .bind(group, now)
        .run(),
    ).rejects.toThrow(/group_full/);
  });

  it("includes ids in your block list so the app can hide blocked people in groups", async () => {
    const zed = await register("zed@example.com", "zedzed", "Zed");
    const amy = await register("amy2@example.com", "amyamy", "Amy");
    await send(zed.cookie, "/api/blocks", { username: "amyamy" });
    const blocks = (await (await send(zed.cookie, "/api/blocks", undefined, "GET")).json()) as { blocks: Array<{ id: string }> };
    expect(blocks.blocks.map((block) => block.id)).toEqual([await userId(amy.cookie)]);
  });
});

async function createGroup(cookie: string, memberIds: string[]): Promise<string> {
  const created = await send(cookie, "/api/groups", { memberIds });
  expect(created.status).toBe(201);
  return ((await created.json()) as { conversation: ConversationDto }).conversation.id;
}

async function messages(cookie: string, conversationId: string): Promise<MessageDto[]> {
  const response = await send(cookie, `/api/conversations/${conversationId}/messages`, undefined, "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { messages: MessageDto[] }).messages;
}

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

