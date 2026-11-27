-- System lines ("Alex added Blair") are messages of kind 'system'. They don't count as unread.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system'));

ALTER TABLE conversations ADD COLUMN last_message_kind TEXT;

UPDATE conversations SET last_message_kind = 'text' WHERE last_message_seq > 0;

-- People added to a group later see messages from when they joined, not the whole history.
ALTER TABLE conversation_members ADD COLUMN history_from_seq INTEGER NOT NULL DEFAULT 0;

-- One invite link per group; admins can reset it.
CREATE TABLE group_invites (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations (id),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- The 25-person limit lives in the database, so two people joining at once can't make 26.
CREATE TRIGGER group_member_limit
BEFORE INSERT ON conversation_members
WHEN (SELECT type FROM conversations WHERE id = NEW.conversation_id) = 'group'
  AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = NEW.conversation_id) >= 25
BEGIN
  SELECT RAISE(ABORT, 'group_full');
END;

DROP TRIGGER messages_after_insert;

CREATE TRIGGER messages_after_insert
AFTER INSERT ON messages
BEGIN
  UPDATE conversations
  SET last_message_seq = NEW.seq,
      last_message_at = NEW.created_at,
      last_message_preview = CASE
        WHEN NEW.kind = 'system' THEN substr(NEW.body, 1, 140)
        WHEN length(trim(NEW.body)) > 0 THEN substr(NEW.body, 1, 140)
        ELSE 'Photo'
      END,
      last_message_sender_id = NEW.sender_id,
      last_message_kind = NEW.kind
  WHERE id = NEW.conversation_id;

  UPDATE conversation_members
  SET unread_count = unread_count + 1
  WHERE conversation_id = NEW.conversation_id
    AND user_id != NEW.sender_id
    AND NEW.kind = 'text';
END;
