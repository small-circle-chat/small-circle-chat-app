-- Chat requests: a stranger who knows your username asks to chat; nothing opens until you accept.
CREATE TABLE chat_requests (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users (id),
  recipient_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  UNIQUE (sender_id, recipient_id),
  CHECK (sender_id != recipient_id)
);

CREATE INDEX chat_requests_recipient ON chat_requests (recipient_id, status);

-- Every request attempt, whether or not the username exists, so the daily cap reveals nothing.
CREATE TABLE chat_request_attempts (
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL
);

CREATE INDEX chat_request_attempts_user ON chat_request_attempts (user_id, created_at);

-- One private invite link per person; anyone who has it can open a chat straight away.
CREATE TABLE invite_links (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
