import { DurableObject } from "cloudflare:workers";
import type { HubEvent } from "../shared/events";

type Attachment = { userId: string };

export class UserHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const userId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    if (!userId) return new Response("Missing user", { status: 400 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [userId]);
    pair[1].serializeAttachment({ userId } satisfies Attachment);
    this.ctx.waitUntil(this.broadcastPresence(userId, true));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async notify(event: HubEvent): Promise<void> {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A socket can close between listing and sending.
      }
    }
  }

  async presence(): Promise<{ online: boolean }> {
    return { online: this.ctx.getWebSockets().length > 0 };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 500) return;

    let body: { type?: string; conversationId?: string; active?: boolean };
    try {
      body = JSON.parse(message) as { type?: string; conversationId?: string; active?: boolean };
    } catch {
      return;
    }
    if (body.type !== "typing" || typeof body.conversationId !== "string") return;

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment?.userId) return;

    const membership = await this.env.DB.prepare(
      `SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?`,
    )
      .bind(body.conversationId, attachment.userId)
      .first();
    if (!membership) return;

    const peers = await this.env.DB.prepare(
      `SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?`,
    )
      .bind(body.conversationId, attachment.userId)
      .all<{ user_id: string }>();

    await fanOut(this.env, peers.results.map((row) => row.user_id), {
      type: "typing",
      conversationId: body.conversationId,
      userId: attachment.userId,
      active: Boolean(body.active),
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment?.userId) return;
    const others = this.ctx.getWebSockets().filter((socket) => socket !== ws);
    if (others.length === 0) await this.broadcastPresence(attachment.userId, false);
  }

  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    const peers = await this.env.DB.prepare(
      `SELECT DISTINCT other.user_id AS user_id
       FROM conversation_members me
       JOIN conversation_members other
         ON other.conversation_id = me.conversation_id
        AND other.user_id != me.user_id
       WHERE me.user_id = ?`,
    )
      .bind(userId)
      .all<{ user_id: string }>();

    await fanOut(this.env, peers.results.map((row) => row.user_id), {
      type: "presence",
      userId,
      online,
    });
  }
}

export async function fanOut(env: Env, userIds: string[], event: HubEvent): Promise<void> {
  const unique = [...new Set(userIds)];
  for (let index = 0; index < unique.length; index += 6) {
    const chunk = unique.slice(index, index + 6);
    await Promise.all(
      chunk.map(async (userId) => {
        try {
          await env.USER_HUB.getByName(userId).notify(event);
        } catch (error) {
          console.error("hub notify failed", userId, error);
        }
      }),
    );
  }
}
