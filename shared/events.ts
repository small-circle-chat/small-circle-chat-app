export type PublicUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
};

export type Peer = {
  id: string;
  username: string;
  displayName: string;
  deleted: boolean;
};

export type AttachmentDto = {
  id: string;
  contentType: string;
  byteSize: number;
};

export type ReactionGroup = {
  emoji: string;
  userIds: string[];
};

export type MessageDto = {
  id: string;
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  seq: number;
  body: string;
  createdAt: number;
  deletedAt: number | null;
  attachments: AttachmentDto[];
  reactions: ReactionGroup[];
};

export type MessagePage = {
  messages: MessageDto[];
  hasMore: boolean;
};

export type MemberDto = {
  id: string;
  username: string;
  displayName: string;
  deleted: boolean;
  role: string;
  lastReadSeq: number;
};

export type ConversationDto = {
  id: string;
  type: "direct" | "group";
  title: string | null;
  /** Everyone in the conversation, including you. `peer` stays for one-to-one chats. */
  members: MemberDto[];
  unreadCount: number;
  lastReadSeq: number;
  peerLastReadSeq: number;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  lastMessageSeq: number;
  peer: Peer;
  peerOnline: boolean;
};

export type ChatRequestDto = {
  id: string;
  createdAt: number;
  from: { username: string; displayName: string };
};

export type HubEvent =
  | { type: "message"; conversationId: string; message: MessageDto }
  | { type: "read"; conversationId: string; userId: string; lastReadSeq: number }
  | { type: "typing"; conversationId: string; userId: string; active: boolean }
  | { type: "presence"; userId: string; online: boolean }
  | { type: "reaction"; conversationId: string; messageId: string; userId: string; emoji: string | null }
  | { type: "message_deleted"; conversationId: string; messageId: string }
  | { type: "chat_request" }
  | { type: "conversation_opened"; conversationId: string };

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
