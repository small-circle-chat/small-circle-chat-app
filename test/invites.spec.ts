/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatRequestDto } from "../shared/events";

const origin = "http://localhost";
const SENT = { ok: true, message: "If that person is on Small Circle Chat, they'll get your request. The chat opens when they accept." };

describe("chat requests", () => {
  it("answers the same way whether or not the username exists", async () => {
    const amy = await register("amy@example.com", "amy", "Amy");
    await register("ben@example.com", "ben", "Ben");
    const blocker = await register("cal@example.com", "cal", "Cal");
    expect((await send(blocker.cookie, "/api/blocks", { username: "amy" })).status).toBe(200);

    for (const username of ["ben", "nobody_here", "amy", "cal"]) {
      const response = await request(amy.cookie, username);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(SENT);
    }
    // Blocking by username also gives nothing away.
    expect((await send(amy.cookie, "/api/blocks", { username: "nobody_here" })).status).toBe(200);
    // The old lookup and direct-open endpoints are gone.
    expect((await send(amy.cookie, "/api/users?username=ben", undefined, "GET")).status).toBe(404);
    expect((await send(amy.cookie, "/api/conversations", undefined, "POST")).status).toBe(404);
    // Cal blocked Amy, so Cal never sees her request.
    expect(await incoming(blocker.cookie)).toEqual([]);
  });

  it("opens nothing until the recipient accepts", async () => {
    const dee = await register("dee@example.com", "dee", "Dee");
    const eve = await register("eve@example.com", "eve", "Eve");
    const eveSocket = await openSocket(eve.cookie);
    const deeSocket = await openSocket(dee.cookie);
    const requested = nextEvent(eveSocket, "chat_request");
    expect((await request(dee.cookie, "eve")).status).toBe(202);
    await requested;

    expect(await conversationCount(dee.cookie)).toBe(0);
    expect(await conversationCount(eve.cookie)).toBe(0);
    const [pending] = await incoming(eve.cookie);
    expect(pending?.from).toEqual({ username: "dee", displayName: "Dee" });

    // Asking again while pending doesn't duplicate it.
    await request(dee.cookie, "eve");
    expect(await incoming(eve.cookie)).toHaveLength(1);

    const opened = nextEvent(deeSocket, "conversation_opened");
    const accepted = await send(eve.cookie, `/api/chat-requests/${pending?.id}/accept`);
    expect(accepted.status).toBe(200);
    const conversation = ((await accepted.json()) as { conversation: { id: string; peer: { username: string } } }).conversation;
    expect(conversation.peer.username).toBe("dee");
    expect(await opened).toEqual({ type: "conversation_opened", conversationId: conversation.id });
    expect(await conversationCount(dee.cookie)).toBe(1);
    expect(await incoming(eve.cookie)).toEqual([]);
    eveSocket.close();
    deeSocket.close();
  });

  it("keeps declines silent and lets mutual requests open the chat", async () => {
    const fin = await register("fin@example.com", "fin", "Fin");
    const gus = await register("gus@example.com", "gus", "Gus");
    await request(fin.cookie, "gus");
    const [first] = await incoming(gus.cookie);
    expect((await send(gus.cookie, `/api/chat-requests/${first?.id}/decline`)).status).toBe(200);
    expect(await request(fin.cookie, "gus").then((r) => r.json())).toEqual(SENT);
    expect(await incoming(gus.cookie)).toEqual([]);

    // Gus changes his mind and asks Fin; Fin asking back opens the chat at once.
    await request(gus.cookie, "fin");
    expect(await incoming(fin.cookie)).toHaveLength(1);
    await request(fin.cookie, "gus");
    expect(await conversationCount(fin.cookie)).toBe(1);
    expect(await conversationCount(gus.cookie)).toBe(1);
    expect(await incoming(fin.cookie)).toEqual([]);
  });

  it("blocks from a request", async () => {
    const hap = await register("hap@example.com", "hap", "Hap");
    const ike = await register("ike@example.com", "ike", "Ike");
    await request(hap.cookie, "ike");
    const [pending] = await incoming(ike.cookie);
    expect((await send(ike.cookie, `/api/chat-requests/${pending?.id}/block`)).status).toBe(200);
    const blocks = (await (await send(ike.cookie, "/api/blocks", undefined, "GET")).json()) as { blocks: Array<{ username: string }> };
    expect(blocks.blocks.map((block) => block.username)).toEqual(["hap"]);
    await request(hap.cookie, "ike");
    expect(await incoming(ike.cookie)).toEqual([]);
    expect((await send(ike.cookie, `/api/chat-requests/${pending?.id}/accept`)).status).toBe(404);
  });

  it("caps request attempts per day, counting guesses too", async () => {
    const jay = await register("jay@example.com", "jay", "Jay");
    await env.DB.prepare(
      `INSERT INTO chat_request_attempts (user_id, created_at)
       SELECT id, ? FROM users WHERE username = 'jay'`,
    )
      .bind(Date.now())
      .run();
    const jayId = (await env.DB.prepare(`SELECT id FROM users WHERE username = 'jay'`).first<{ id: string }>())?.id;
    for (let index = 0; index < 18; index += 1) {
      await env.DB.prepare(`INSERT INTO chat_request_attempts (user_id, created_at) VALUES (?, ?)`).bind(jayId, Date.now()).run();
    }
    expect((await request(jay.cookie, "made_up_name")).status).toBe(202);
    expect((await request(jay.cookie, "another_guess")).status).toBe(429);
  });
});

describe("invite links", () => {
  it("opens a chat straight away and can be reset", async () => {
    const kai = await register("kai@example.com", "kai", "Kai");
    const liv = await register("liv@example.com", "liv", "Liv");
    const first = await inviteToken(kai.cookie);
    expect(await inviteToken(kai.cookie)).toBe(first);

    expect((await redeem(kai.cookie, first)).status).toBe(400);

    const kaiSocket = await openSocket(kai.cookie);
    const opened = nextEvent(kaiSocket, "conversation_opened");
    const redeemed = await redeem(liv.cookie, first);
    expect(redeemed.status).toBe(201);
    const conversation = ((await redeemed.json()) as { conversation: { id: string; peer: { username: string } } }).conversation;
    expect(conversation.peer.username).toBe("kai");
    expect(await opened).toEqual({ type: "conversation_opened", conversationId: conversation.id });
    expect((await redeem(liv.cookie, first)).status).toBe(200);
    kaiSocket.close();

    const reset = await send(kai.cookie, "/api/invite/reset");
    const second = ((await reset.json()) as { token: string }).token;
    expect(second).not.toBe(first);
    const mae = await register("mae@example.com", "mae", "Mae");
    expect((await redeem(mae.cookie, first)).status).toBe(404);
    expect((await redeem(mae.cookie, "not-a-token")).status).toBe(404);
    expect((await redeem(mae.cookie, second)).status).toBe(201);
  });

  it("stops working when the owner deletes their account or blocks you", async () => {
    const ned = await register("ned@example.com", "ned", "Ned");
    const ola = await register("ola@example.com", "ola", "Ola");
    const pip = await register("pip@example.com", "pip", "Pip");
    const nedToken = await inviteToken(ned.cookie);
    const olaToken = await inviteToken(ola.cookie);
    expect((await send(ola.cookie, "/api/blocks", { username: "pip" })).status).toBe(200);
    expect((await redeem(pip.cookie, olaToken)).status).toBe(404);
    expect((await send(ned.cookie, "/api/me", undefined, "DELETE")).status).toBe(200);
    expect((await redeem(pip.cookie, nedToken)).status).toBe(404);
  });
});

async function request(cookie: string, username: string): Promise<Response> {
  return send(cookie, "/api/chat-requests", { username });
}

async function incoming(cookie: string): Promise<ChatRequestDto[]> {
  const response = await send(cookie, "/api/chat-requests", undefined, "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { requests: ChatRequestDto[] }).requests;
}

async function conversationCount(cookie: string): Promise<number> {
  const response = await send(cookie, "/api/conversations", undefined, "GET");
  return ((await response.json()) as { conversations: unknown[] }).conversations.length;
}

async function inviteToken(cookie: string): Promise<string> {
  const response = await send(cookie, "/api/invite", undefined, "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function redeem(cookie: string, token: string): Promise<Response> {
  return send(cookie, "/api/invite/redeem", { token });
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

