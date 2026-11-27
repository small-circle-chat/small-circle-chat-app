import { env, SELF } from "cloudflare:test";

const origin = "http://localhost";

/**
 * Opens a chat with `username` the way the app does now: through that person's invite link.
 * The link is written straight into the database so tests don't need the other person's session.
 */
export async function openDirectResponse(cookie: string, username: string): Promise<Response> {
  const target = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first<{ id: string }>();
  if (!target) throw new Error(`No test user ${username}`);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  await env.DB.prepare(
    `INSERT INTO invite_links (user_id, token, created_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET token = excluded.token`,
  )
    .bind(target.id, token, Date.now())
    .run();
  return SELF.fetch(`${origin}/api/invite/redeem`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie: cookie.split(";")[0] ?? cookie },
    body: JSON.stringify({ token }),
  });
}
