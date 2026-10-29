CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  uploader_id TEXT NOT NULL REFERENCES users (id),
  message_id TEXT REFERENCES messages (id),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX attachments_message ON attachments (message_id);

DROP TRIGGER messages_after_insert;

CREATE TRIGGER messages_after_insert
AFTER INSERT ON messages
BEGIN
  UPDATE conversations
  SET last_message_seq = NEW.seq,
      last_message_at = NEW.created_at,
      last_message_preview = CASE
        WHEN length(trim(NEW.body)) > 0 THEN substr(NEW.body, 1, 140)
        ELSE 'Photo'
      END,
      last_message_sender_id = NEW.sender_id
  WHERE id = NEW.conversation_id;

  UPDATE conversation_members
  SET unread_count = unread_count + 1
  WHERE conversation_id = NEW.conversation_id
    AND user_id != NEW.sender_id;
END;
