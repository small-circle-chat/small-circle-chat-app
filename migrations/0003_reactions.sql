CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  emoji TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX message_reactions_message ON message_reactions (message_id);
