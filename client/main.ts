import type { ApiError, ConversationDto, HubEvent, MessageDto, PublicUser } from "../shared/events";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app");

type Me = PublicUser;
type LocalMessage = MessageDto & { pending?: boolean; failed?: boolean; localPreviews?: string[] };

let me: Me | null = null;
let conversations: ConversationDto[] = [];
let activeId: string | null = null;
let messages: LocalMessage[] = [];
let oldestSeq: number | null = null;
let loadingOlder = false;
let socket: WebSocket | null = null;
let retryMs = 500;
let typingTimer = 0;
let peerTyping = false;
let banner = "";
let mode: "login" | "register" = "login";
let accountOpen = false;
let accountError = "";
let accountDraft: { username: string; displayName: string } | null = null;
let devLink = "";
let draftText = "";
let drafts: Array<{ file: File; url: string }> = [];
let viewerSrc: string | null = null;

const root = app;

bindVisualViewport();
void boot();

function bindVisualViewport(): void {
  const viewport = window.visualViewport;
  const smallViewport = measureViewportUnit("100svh");
  let baselineHeight: number | null = null;
  let trustReportedHeight = false;
  let appliedHeight = -1;
  let appliedTop = -1;
  let pinFrame = 0;
  const sync = () => {
    const reported = Math.round(viewport?.height ?? window.innerHeight);
    const offsetTop = Math.round(viewport?.offsetTop ?? 0);
    if (baselineHeight === null) baselineHeight = reported;
    if (reported !== baselineHeight || offsetTop !== 0) trustReportedHeight = true;
    // On first load Safari can report the tall layout viewport while its URL
    // bar and bottom toolbar are still covering the page. Stay within the
    // small viewport until the visual viewport actually moves.
    const height = !trustReportedHeight && smallViewport > 0 ? Math.min(reported, smallViewport) : reported;
    if (height <= 0 || (height === appliedHeight && offsetTop === appliedTop)) return;
    const scroller = document.querySelector<HTMLElement>("#thread .messages");
    const pinned = scroller !== null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    document.documentElement.style.setProperty("--vvh", `${height}px`);
    document.documentElement.style.setProperty("--vv-top", `${offsetTop}px`);
    appliedHeight = height;
    appliedTop = offsetTop;
    if (!pinned || !scroller) return;
    cancelAnimationFrame(pinFrame);
    pinFrame = requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  };
  sync();
  viewport?.addEventListener("resize", sync);
  viewport?.addEventListener("scroll", sync);
  window.addEventListener("orientationchange", () => {
    sync();
    window.setTimeout(sync, 250);
  });
}

function measureViewportUnit(height: string): number {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.top = "0";
  probe.style.height = height;
  probe.style.width = "0";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  document.documentElement.append(probe);
  const measured = Math.round(probe.getBoundingClientRect().height);
  probe.remove();
  return measured;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  if (location.pathname === "/auth/verify" && token) {
    renderCheck("Signing you in…");
    await verify(token);
    return;
  }
  const response = await api<unknown>("/api/me");
  if (response.ok && isMe(response.data)) {
    me = response.data.user;
    await showApp();
    return;
  }
  renderAuth();
}

function renderAuth(): void {
  document.title = "Messages";
  root.innerHTML = "";
  const wrap = el("main", "auth");
  const card = el("section", "card");
  card.append(el("h1", "", "Messages"));
  card.append(el("p", "lede", "Sign in with a link sent to your email. No password."));
  const tabs = el("div", "tabs");
  tabs.append(
    tabButton("Sign in", mode === "login", () => { mode = "login"; renderAuth(); }),
    tabButton("Create account", mode === "register", () => { mode = "register"; renderAuth(); }),
  );
  const form = document.createElement("form");
  const email = field("Email", "email", "you@example.com");
  form.append(email.label);
  let username: ReturnType<typeof field> | null = null;
  let displayName: ReturnType<typeof field> | null = null;
  if (mode === "register") {
    username = field("Username", "text", "ada");
    displayName = field("Display name", "text", "Ada Lovelace");
    form.append(username.label, displayName.label);
  }
  const submit = el("button", "primary", mode === "login" ? "Email me a link" : "Create account") as HTMLButtonElement;
  submit.type = "submit";
  submit.style.marginTop = "18px";
  form.append(submit);
  const error = el("p", "banner");
  error.hidden = !banner;
  error.textContent = banner;
  form.append(error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    banner = "";
    submit.disabled = true;
    const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const payload: Record<string, string> = { email: email.input.value };
    if (username && displayName) {
      payload.username = username.input.value;
      payload.displayName = displayName.input.value;
    }
    const result = await api<AuthResponse>(path, { method: "POST", body: payload });
    submit.disabled = false;
    if (!result.ok) {
      banner = result.message;
      renderAuth();
      return;
    }
    devLink = result.data.devLink ?? "";
    renderCheck(result.data.message);
  });
  card.append(tabs, form);
  wrap.append(card);
  root.append(wrap);
}

function renderCheck(message: string): void {
  root.innerHTML = "";
  const wrap = el("main", "check-email");
  const card = el("section", "card");
  card.append(el("h1", "", "Check your email"));
  card.append(el("p", "lede", message));
  if (devLink) {
    const note = el("p", "lede", "Mail is not configured, so this local link is shown only on localhost.");
    const anchor = document.createElement("a");
    anchor.href = devLink;
    anchor.textContent = devLink;
    anchor.className = "dev-link";
    card.append(note, anchor);
  }
  const back = el("button", "ghost", "Use a different email") as HTMLButtonElement;
  back.type = "button";
  back.addEventListener("click", () => { devLink = ""; banner = ""; renderAuth(); });
  card.append(back);
  wrap.append(card);
  root.append(wrap);
}

async function verify(token: string): Promise<void> {
  const result = await api<{ user: Me }>("/api/auth/verify", { method: "POST", body: { token } });
  history.replaceState(null, "", "/");
  if (!result.ok) {
    banner = result.message;
    renderAuth();
    return;
  }
  me = result.data.user;
  await showApp();
}

async function showApp(): Promise<void> {
  renderShell();
  connect();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  await refresh();
}

function renderShell(): void {
  root.innerHTML = "";
  const shell = el("div", "shell");
  if (activeId) shell.classList.add("thread-open");
  const sidebar = el("aside", "sidebar");
  const head = el("div", "sidebar-head");
  const logout = el("button", "ghost", "Log out") as HTMLButtonElement;
  logout.type = "button";
  logout.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: {} });
    me = null;
    accountOpen = false;
    accountDraft = null;
    closeViewer();
    socket?.close();
    banner = "";
    renderAuth();
  });
  const account = el("button", "ghost", "Account") as HTMLButtonElement;
  account.type = "button";
  account.setAttribute("aria-pressed", accountOpen ? "true" : "false");
  account.addEventListener("click", () => {
    accountOpen = !accountOpen;
    accountError = "";
    accountDraft = null;
    renderShell();
  });
  const actions = el("div", "row");
  actions.append(account, logout);
  const identity = el("div", "identity");
  identity.append(el("h2", "", me?.displayName ?? "Messages"));
  identity.append(el("div", "meta", me ? `@${me.username}` : ""));
  head.append(identity, actions);
  const accountForm = accountOpen ? renderAccountForm() : null;
  const finder = document.createElement("form");
  finder.className = "finder";
  const username = field("Start a conversation", "text", "username");
  const start = el("button", "primary", "Open") as HTMLButtonElement;
  start.type = "submit";
  finder.append(username.label, start);
  const findError = el("p", "banner");
  findError.hidden = true;
  finder.append(findError);
  finder.addEventListener("submit", async (event) => {
    event.preventDefault();
    start.disabled = true;
    const result = await api<{ conversation: ConversationDto }>("/api/conversations", {
      method: "POST",
      body: { username: username.input.value },
    });
    start.disabled = false;
    if (!result.ok) {
      findError.hidden = false;
      findError.textContent = result.message;
      return;
    }
    findError.hidden = true;
    username.input.value = "";
    upsertConversation(result.data.conversation);
    await openConversation(result.data.conversation.id);
  });
  const list = el("div", "conversation-list");
  list.id = "conversation-list";
  sidebar.append(head, ...(accountForm ? [accountForm] : []), finder, list);
  const thread = el("section", "thread");
  thread.id = "thread";
  shell.append(sidebar, thread);
  root.append(shell);
  paintList();
  paintThread();
}

function renderAccountForm(): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "account";
  const username = field("Username", "text", "ada");
  const displayName = field("Display name", "text", "Ada Lovelace");
  username.input.value = accountDraft?.username ?? me?.username ?? "";
  displayName.input.value = accountDraft?.displayName ?? me?.displayName ?? "";
  username.input.autocomplete = "username";
  displayName.input.autocomplete = "name";
  const error = el("p", "banner", accountError);
  error.hidden = accountError.length === 0;
  const save = el("button", "primary", "Save") as HTMLButtonElement;
  save.type = "submit";
  const cancel = el("button", "ghost", "Cancel") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    accountOpen = false;
    accountError = "";
    accountDraft = null;
    renderShell();
  });
  const actions = el("div", "row");
  actions.append(save, cancel);
  form.append(username.label, displayName.label, error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    const result = await api<{ user: Me }>("/api/me", {
      method: "PATCH",
      body: { username: username.input.value, displayName: displayName.input.value },
    });
    save.disabled = false;
    if (!result.ok) {
      accountDraft = { username: username.input.value, displayName: displayName.input.value };
      accountError = result.message;
      renderShell();
      return;
    }
    me = result.data.user;
    accountOpen = false;
    accountError = "";
    accountDraft = null;
    renderShell();
  });
  return form;
}

function paintList(): void {
  paintTitle();
  const list = document.querySelector("#conversation-list");
  if (!list) return;
  const caret = captureComposerCaret();
  try {
    list.replaceChildren();
    if (conversations.length === 0) {
      list.append(el("p", "empty", "Find someone by their exact username."));
      return;
    }
    for (const conversation of conversations) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "conversation";
      button.setAttribute("aria-current", conversation.id === activeId ? "true" : "false");
      const name = el("strong", "", conversation.peer.displayName);
      const meta = el("span", "meta", `@${conversation.peer.username}`);
      const preview = el("span", "preview", conversation.lastMessagePreview ?? "No messages yet");
      button.append(name, meta, preview);
      if (conversation.unreadCount > 0) button.append(el("span", "unread", String(conversation.unreadCount)));
      button.addEventListener("click", () => void openConversation(conversation.id));
      list.append(button);
    }
  } finally {
    restoreComposerCaret(caret);
  }
}

function paintTitle(): void {
  const unread = conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);
  document.title = unread > 0 ? `(${unread}) Messages` : "Messages";
}

function paintThread(): void {
  const thread = document.querySelector("#thread");
  if (!thread) return;
  const caret = captureComposerCaret();
  const conversation = conversations.find((item) => item.id === activeId);
  if (!conversation) {
    thread.replaceChildren(el("p", "empty", "Choose a conversation or start a new one."));
    thread.removeAttribute("data-conversation-id");
    return;
  }
  const head = el("div", "thread-head");
  const title = el("div");
  const back = el("button", "ghost", "Back") as HTMLButtonElement;
  back.type = "button";
  back.addEventListener("click", () => {
    activeId = null;
    closeViewer();
    document.querySelector(".shell")?.classList.remove("thread-open");
    paintList();
    paintThread();
  });
  title.append(el("h2", "", conversation.peer.displayName));
  title.append(el("div", "presence", conversation.peerOnline ? "Online" : "Offline"));
  const block = el("button", "ghost", "Block") as HTMLButtonElement;
  block.type = "button";
  block.addEventListener("click", async () => {
    const result = await api("/api/blocks", { method: "POST", body: { username: conversation.peer.username } });
    if (!result.ok) {
      banner = result.message;
      paintThread();
      return;
    }
    banner = `${conversation.peer.displayName} is blocked.`;
    paintThread();
  });
  head.append(back, title, block);
  const older = el("button", "ghost", loadingOlder ? "Loading…" : "Load earlier messages") as HTMLButtonElement;
  older.type = "button";
  older.disabled = loadingOlder || oldestSeq === null || oldestSeq <= 1;
  older.addEventListener("click", () => void loadOlder());
  const scroller = el("div", "messages");
  if (banner) scroller.append(el("p", "banner", banner));
  if (messages.length === 0) scroller.append(el("p", "empty", "Say hello."));
  for (const message of messages) {
    const bubble = el("div", "bubble");
    if (message.senderId === me?.id) bubble.classList.add("mine");
    if (message.pending) bubble.classList.add("pending");
    if (message.failed) bubble.classList.add("failed");
    for (const url of message.localPreviews ?? []) bubble.append(image(url, true));
    if (!message.localPreviews?.length) {
      for (const attachment of message.attachments) {
        bubble.append(image(`/api/conversations/${message.conversationId}/attachments/${attachment.id}`, true));
      }
    }
    if (message.body) bubble.append(document.createTextNode(message.body));
    const caption = message.failed ? "Not sent. Retry from the composer." : message.pending ? "Sending…" : formatTime(message.createdAt);
    const read = message.senderId === me?.id && conversation.peerLastReadSeq >= message.seq && !message.pending;
    bubble.append(el("small", "", read ? `${caption} · Read` : caption));
    scroller.append(bubble);
  }
  const transcript = el("div", "transcript");
  const typing = el("div", "typing", peerTyping ? `${conversation.peer.displayName} is typing` : "");
  transcript.append(scroller, typing);
  const draftsRow = el("div", "drafts");
  for (const [index, draft] of drafts.entries()) {
    const figure = el("div", "draft");
    figure.append(image(draft.url, true));
    const remove = el("button", "ghost", "Remove") as HTMLButtonElement;
    remove.type = "button";
    remove.addEventListener("click", () => {
      const removed = drafts.splice(index, 1)[0];
      if (removed) URL.revokeObjectURL(removed.url);
      paintThread();
    });
    figure.append(remove);
    draftsRow.append(figure);
  }
  const parked = thread.querySelector("form.composer");
  let form: HTMLFormElement;
  if (parked instanceof HTMLFormElement && thread.getAttribute("data-conversation-id") === conversation.id) {
    const box = parked.querySelector("textarea");
    if (box instanceof HTMLTextAreaElement && box.value !== draftText) box.value = draftText;
    form = parked;
  } else {
    form = buildComposer();
  }
  for (const child of [...thread.children]) {
    if (child !== form) child.remove();
  }
  thread.setAttribute("data-conversation-id", conversation.id);
  thread.append(head, older, transcript, draftsRow, form);
  scroller.scrollTop = scroller.scrollHeight;
  restoreComposerCaret(caret);
}

function buildComposer(): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "composer";
  const box = document.createElement("textarea");
  box.rows = 2;
  box.placeholder = "Write a message";
  box.maxLength = 4000;
  box.value = draftText;
  box.addEventListener("input", () => {
    draftText = box.value;
    sendTyping(true);
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/jpeg,image/png,image/gif,image/webp";
  picker.multiple = true;
  picker.hidden = true;
  picker.addEventListener("change", () => {
    const selected = [...(picker.files ?? [])];
    picker.value = "";
    for (const file of selected) {
      if (drafts.length >= 4) {
        banner = "A message can include up to 4 images.";
        break;
      }
      drafts.push({ file, url: URL.createObjectURL(file) });
    }
    paintThread();
  });
  const add = el("button", "icon") as HTMLButtonElement;
  add.type = "button";
  add.setAttribute("aria-label", "Add image");
  add.append(iconSvg("M12 5v14M5 12h14"));
  add.addEventListener("click", () => picker.click());
  const send = el("button", "primary", "Send") as HTMLButtonElement;
  send.type = "submit";
  form.append(box, picker, add, send);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = box.value.trim();
    const pending = drafts.splice(0, drafts.length);
    if (!body && pending.length === 0) return;
    draftText = "";
    sendTyping(false);
    await sendMessage(body, pending.map((draft) => draft.file), pending.map((draft) => draft.url));
  });
  return form;
}

async function refresh(): Promise<void> {
  const result = await api<{ conversations: ConversationDto[] }>("/api/conversations");
  if (!result.ok) {
    if (result.status === 401) {
      me = null;
      renderAuth();
    }
    return;
  }
  conversations = result.data.conversations;
  paintList();
  if (activeId) await reloadActive();
}

async function openConversation(id: string): Promise<void> {
  activeId = id;
  peerTyping = false;
  banner = "";
  closeViewer();
  resetComposer();
  document.querySelector(".shell")?.classList.add("thread-open");
  messages = [];
  paintList();
  paintThread();
  await reloadActive();
}

async function reloadActive(): Promise<void> {
  if (!activeId) return;
  const [detail, history] = await Promise.all([
    api<{ conversation: ConversationDto }>(`/api/conversations/${activeId}`),
    api<{ messages: MessageDto[] }>(`/api/conversations/${activeId}/messages`),
  ]);
  if (!detail.ok) {
    banner = detail.message;
    paintThread();
    return;
  }
  if (!history.ok) {
    banner = history.message;
    paintThread();
    return;
  }
  upsertConversation(detail.data.conversation);
  messages = history.data.messages;
  oldestSeq = messages[0]?.seq ?? null;
  paintList();
  paintThread();
  const latest = messages.at(-1);
  if (latest) await markRead(latest.seq);
}

async function loadOlder(): Promise<void> {
  if (!activeId || oldestSeq === null) return;
  loadingOlder = true;
  paintThread();
  const result = await api<{ messages: MessageDto[] }>(`/api/conversations/${activeId}/messages?before_seq=${oldestSeq}`);
  loadingOlder = false;
  if (!result.ok) {
    banner = result.message;
    paintThread();
    return;
  }
  const existing = new Set(messages.map((message) => message.id));
  messages = [...result.data.messages.filter((message) => !existing.has(message.id)), ...messages];
  oldestSeq = messages[0]?.seq ?? oldestSeq;
  paintThread();
}

function resetComposer(): void {
  for (const draft of drafts) URL.revokeObjectURL(draft.url);
  drafts = [];
  draftText = "";
}

function image(src: string, viewable = false): HTMLElement {
  const img = document.createElement("img");
  img.className = "attachment";
  img.alt = "Image";
  img.src = src;
  if (!viewable) return img;
  const button = el("button", "attachment-button") as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-label", "View image");
  button.addEventListener("click", () => openViewer(src));
  button.append(img);
  return button;
}

function openViewer(src: string): void {
  viewerSrc = src;
  paintViewer();
}

function closeViewer(): void {
  if (!viewerSrc && !document.querySelector(".viewer")) return;
  viewerSrc = null;
  document.querySelector(".viewer")?.remove();
  document.removeEventListener("keydown", onViewerKey);
}

function onViewerKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeViewer();
}

function paintViewer(): void {
  document.querySelector(".viewer")?.remove();
  if (!viewerSrc) return;
  const viewer = el("div", "viewer");
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", "Image");
  const img = document.createElement("img");
  img.src = viewerSrc;
  img.alt = "Image";
  const close = el("button", "icon close") as HTMLButtonElement;
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.append(iconSvg("M6 6l12 12M18 6L6 18"));
  close.addEventListener("click", () => closeViewer());
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) closeViewer();
  });
  viewer.append(close, img);
  document.body.append(viewer);
  document.addEventListener("keydown", onViewerKey);
  close.focus();
}

function iconSvg(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "none");
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "2");
  shape.setAttribute("stroke-linecap", "round");
  svg.append(shape);
  return svg;
}

function markFailed(clientMsgId: string): void {
  const failed = messages.find((message) => message.clientMsgId === clientMsgId);
  if (failed) {
    failed.pending = false;
    failed.failed = true;
  }
  paintThread();
}

async function uploadImage(conversationId: string, file: File): Promise<{ id: string } | null> {
  const form = new FormData();
  form.append("file", file);
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${conversationId}/attachments`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
  } catch {
    banner = "The network request failed.";
    return null;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    banner = isApiError(data) ? data.error.message : "The image could not be uploaded.";
    return null;
  }
  const attachment = (data as { attachment?: { id: string } }).attachment;
  return attachment?.id ? { id: attachment.id } : null;
}

async function cancelUpload(conversationId: string, id: string): Promise<void> {
  await api(`/api/conversations/${conversationId}/attachments/${id}`, { method: "DELETE" });
}

async function sendMessage(body: string, files: File[], previews: string[]): Promise<void> {
  if (!activeId) return;
  const conversationId = activeId;
  const clientMsgId = crypto.randomUUID();
  const optimistic: LocalMessage = {
    id: clientMsgId,
    conversationId,
    senderId: me?.id ?? "",
    clientMsgId,
    seq: (messages.at(-1)?.seq ?? 0) + 1,
    body,
    createdAt: Date.now(),
    attachments: [],
    localPreviews: previews,
    pending: true,
  };
  messages.push(optimistic);
  paintThread();
  const attachmentIds: string[] = [];
  for (const file of files) {
    const uploaded = await uploadImage(conversationId, file);
    if (!uploaded) {
      for (const id of attachmentIds) await cancelUpload(conversationId, id);
      markFailed(clientMsgId);
      return;
    }
    attachmentIds.push(uploaded.id);
  }
  const result = await api<{ message: MessageDto }>(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { clientMsgId, body, attachmentIds },
  });
  if (!result.ok) {
    for (const id of attachmentIds) await cancelUpload(conversationId, id);
    markFailed(clientMsgId);
    banner = result.message;
    paintThread();
    return;
  }
  for (const url of previews) URL.revokeObjectURL(url);
  replaceMessage(result.data.message);
  paintList();
  paintThread();
}

function replaceMessage(message: MessageDto): void {
  const index = messages.findIndex((item) => item.id === message.id || item.clientMsgId === message.clientMsgId);
  if (index === -1) messages.push(message);
  else messages[index] = message;
  messages.sort((left, right) => left.seq - right.seq);
  const conversation = conversations.find((item) => item.id === message.conversationId);
  if (!conversation) {
    void refresh();
    return;
  }
  const isNew = message.seq > conversation.lastMessageSeq;
  conversation.lastMessagePreview = message.body.trim() ? message.body.slice(0, 140) : "Photo";
  conversation.lastMessageAt = message.createdAt;
  if (isNew) conversation.lastMessageSeq = message.seq;
  if (isNew && message.senderId !== me?.id && activeId !== message.conversationId) {
    conversation.unreadCount += 1;
  }
}

async function markRead(seq: number): Promise<void> {
  if (!activeId) return;
  const conversation = conversations.find((item) => item.id === activeId);
  if (!conversation || conversation.lastReadSeq >= seq) return;
  const result = await api<{ lastReadSeq: number }>(`/api/conversations/${activeId}/read`, {
    method: "POST",
    body: { lastReadSeq: seq },
  });
  if (!result.ok) return;
  conversation.lastReadSeq = result.data.lastReadSeq;
  conversation.unreadCount = 0;
  paintList();
}

function upsertConversation(conversation: ConversationDto): void {
  const index = conversations.findIndex((item) => item.id === conversation.id);
  if (index === -1) conversations.unshift(conversation);
  else conversations[index] = conversation;
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/api/ws`);
  socket.addEventListener("open", () => {
    retryMs = 500;
    void refresh();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let payload: HubEvent;
    try {
      payload = JSON.parse(event.data) as HubEvent;
    } catch {
      return;
    }
    handleEvent(payload);
  });
  socket.addEventListener("close", () => {
    window.setTimeout(() => connect(), retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  });
}

function handleEvent(event: HubEvent): void {
  if (event.type === "message") {
    if (event.conversationId === activeId) {
      replaceMessage(event.message);
      paintThread();
      void markRead(event.message.seq);
    } else {
      replaceMessage(event.message);
      paintList();
    }
    return;
  }
  if (event.type === "read") {
    const conversation = conversations.find((item) => item.id === event.conversationId);
    if (!conversation) return;
    if (event.userId === conversation.peer.id) conversation.peerLastReadSeq = event.lastReadSeq;
    if (event.userId === me?.id) {
      conversation.lastReadSeq = event.lastReadSeq;
      conversation.unreadCount = 0;
    }
    paintList();
    if (event.conversationId === activeId) paintThread();
    return;
  }
  if (event.type === "typing" && event.conversationId === activeId && event.userId !== me?.id) {
    peerTyping = event.active;
    const caret = captureComposerCaret();
    const node = document.querySelector(".typing");
    const conversation = conversations.find((item) => item.id === activeId);
    if (node && conversation) {
      const next = event.active ? `${conversation.peer.displayName} is typing` : "";
      if (node.textContent !== next) node.textContent = next;
    }
    restoreComposerCaret(caret);
    return;
  }
  if (event.type === "presence") {
    for (const conversation of conversations) {
      if (conversation.peer.id === event.userId) conversation.peerOnline = event.online;
    }
    paintThread();
  }
}

function sendTyping(active: boolean): void {
  if (!activeId || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "typing", conversationId: activeId, active }));
  window.clearTimeout(typingTimer);
  if (active) typingTimer = window.setTimeout(() => sendTyping(false), 2000);
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<
  { ok: true; data: T } | { ok: false; status: number; message: string }
> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, status: 0, message: "The network request failed." };
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isApiError(data) ? data.error.message : "Something went wrong.";
    return { ok: false, status: response.status, message };
  }
  return { ok: true, data: data as T };
}

function isApiError(value: unknown): value is ApiError {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as ApiError).error;
  return Boolean(error && typeof error.message === "string");
}

function isMe(value: unknown): value is { user: Me } {
  if (!value || typeof value !== "object" || !("user" in value)) return false;
  const user = (value as { user: Me }).user;
  return Boolean(user && typeof user.id === "string" && typeof user.username === "string");
}

type AuthResponse = { ok: true; message: string; devLink?: string };

function field(labelText: string, type: string, placeholder: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.append(document.createTextNode(labelText));
  const input = document.createElement("input");
  input.type = type;
  input.required = true;
  input.placeholder = placeholder;
  input.autocomplete = type === "email" ? "email" : "off";
  label.append(input);
  return { label, input };
}

function tabButton(text: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const button = el("button", "", text) as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  button.addEventListener("click", onClick);
  return button;
}

function el(tag: string, className = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

type ComposerCaret = {
  box: HTMLTextAreaElement;
  start: number;
  end: number;
  value: string;
};

function captureComposerCaret(): ComposerCaret | null {
  const box = document.querySelector("#thread textarea");
  if (!(box instanceof HTMLTextAreaElement) || document.activeElement !== box) return null;
  return { box, start: box.selectionStart, end: box.selectionEnd, value: box.value };
}

function restoreComposerCaret(caret: ComposerCaret | null): void {
  applyComposerCaret(caret);
  queueMicrotask(() => applyComposerCaret(caret));
}

function applyComposerCaret(caret: ComposerCaret | null): void {
  if (!caret?.box.isConnected) return;
  if (document.activeElement !== caret.box) caret.box.focus({ preventScroll: true });
  if (caret.box.value !== caret.value) return;
  if (caret.box.selectionStart !== caret.start || caret.box.selectionEnd !== caret.end) {
    caret.box.setSelectionRange(caret.start, caret.end);
  }
}
