/// <reference types="@cloudflare/vitest-pool-workers" />
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "http://localhost";
const DAY = 24 * 60 * 60 * 1000;

describe("abandoned attachment cleanup", () => {
  it("weekly job removes old unsent uploads and keeps everything else", async () => {
    const kim = await register("kim@example.com", "kim", "Kim");
    await register("lee@example.com", "lee", "Lee");
    const conversationId = await openDirect(kim.cookie, "lee");

    const abandoned = await uploadId(kim.cookie, conversationId);
    const recent = await uploadId(kim.cookie, conversationId);
    const sent = await uploadId(kim.cookie, conversationId);
    const posted = await send(kim.cookie, `/api/conversations/${conversationId}/messages`, {
      clientMsgId: crypto.randomUUID(),
      body: "",
      attachmentIds: [sent],
    });
    expect(posted.status).toBe(201);
    await env.DB.prepare(`UPDATE attachments SET created_at = ? WHERE id IN (?, ?)`)
      .bind(Date.now() - 2 * DAY, abandoned, sent)
      .run();

    const controller = createScheduledController({ scheduledTime: Date.now(), cron: "0 4 * * 1" });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const rows = await env.DB.prepare(`SELECT id FROM attachments ORDER BY id`).all<{ id: string }>();
    expect(rows.results.map((row) => row.id).sort()).toEqual([recent, sent].sort());
    expect(await env.MEDIA.head(key(conversationId, abandoned))).toBeNull();
    expect(await env.MEDIA.head(key(conversationId, recent))).not.toBeNull();
    expect(await env.MEDIA.head(key(conversationId, sent))).not.toBeNull();
  });
});

function key(conversationId: string, attachmentId: string): string {
  return `conversations/${conversationId}/${attachmentId}`;
}

async function uploadId(cookie: string, conversationId: string): Promise<string> {
  const uploaded = await upload(cookie, conversationId, PNG, "dot.png", "image/png");
  expect(uploaded.status).toBe(201);
  return ((await uploaded.json()) as { attachment: { id: string } }).attachment.id;
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

