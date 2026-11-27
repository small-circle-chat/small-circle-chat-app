-- Hands out message numbers from a per-conversation counter instead of "highest so far + 1",
-- so many people sending at once can't collide.
ALTER TABLE conversations ADD COLUMN seq_counter INTEGER NOT NULL DEFAULT 0;

UPDATE conversations
SET seq_counter = COALESCE((SELECT MAX(seq) FROM messages WHERE messages.conversation_id = conversations.id), 0);
