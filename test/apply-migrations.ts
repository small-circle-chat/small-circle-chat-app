import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql?raw";
import attachments from "../migrations/0002_attachments.sql?raw";

// D1 exec treats a newline as the end of a statement, so each script is flattened.
await env.DB.exec(schema.replace(/\s+/g, " "));
await env.DB.exec(attachments.replace(/\s+/g, " "));
