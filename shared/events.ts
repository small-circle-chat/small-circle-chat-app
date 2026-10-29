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
  attachments: AttachmentDto[];
  reactions: ReactionGroup[];
};

export type MessagePage = {
  messages: MessageDto[];
  hasMore: boolean;
};

export type ConversationDto = {
  id: string;
  unreadCount: number;
  lastReadSeq: number;
  peerLastReadSeq: number;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  lastMessageSeq: number;
  peer: Peer;
  peerOnline: boolean;
};

export type HubEvent =
  | { type: "message"; conversationId: string; message: MessageDto }
  | { type: "read"; conversationId: string; userId: string; lastReadSeq: number }
  | { type: "typing"; conversationId: string; userId: string; active: boolean }
  | { type: "presence"; userId: string; online: boolean }
  | { type: "reaction"; conversationId: string; messageId: string; userId: string; emoji: string | null };

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
