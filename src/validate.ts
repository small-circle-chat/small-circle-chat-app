const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) return null;
  return username;
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > 40) return null;
  return displayName;
}

export function normalizeMessageBody(value: unknown, options?: { allowEmpty?: boolean }): string | null {
  if (value === undefined || value === null) return options?.allowEmpty ? "" : null;
  if (typeof value !== "string") return null;
  const body = value.trim();
  if (body.length > 4000) return null;
  if (body.length < 1 && !options?.allowEmpty) return null;
  return body;
}

export function normalizeAttachmentIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item)) return null;
    ids.push(item.toLowerCase());
  }
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

export function normalizeClientMessageId(value: unknown): string | null {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

export function allowsDevLink(request: Request, env: Env): boolean {
  if (env.MAILCHANNELS_API_KEY && env.MAIL_FROM) return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}
