import { planReconnect } from "./view.js";

const state = {
  token: localStorage.getItem("porch.token") || "",
  me: null,
  maxUploadMb: 8,
  conversations: [],
  people: [],
  presence: new Set(),
  activeId: Number(sessionStorage.getItem("porch.active") || 0) || null,
  messages: [],
  hasMore: false,
  panel: "chats",
  admin: false,
  connected: false,
  kicked: false,
  typing: new Map(),
  file: null,
  addresses: [],
  readUpTo: 0,
};

const $ = (id) => document.getElementById(id);
let socket;
let toastTimer;
let addressTimer;
let typingTimer;
let typingSent = false;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    const error = new Error("Can't reach the host. Check the network and that Garh-Comn is running.");
    error.network = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !options.allow401) {
    forceLogout("Your session ended.");
    const error = new Error("unauthorized");
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showBoot(message) {
  $("boot").hidden = false;
  $("login-view").hidden = true;
  $("app").hidden = true;
  $("boot").querySelector(".muted").textContent = message || "Opening the room…";
}

function showLogin(message) {
  $("boot").hidden = true;
  $("app").hidden = true;
  $("login-view").hidden = false;
  const error = $("login-error");
  error.hidden = !message;
  error.textContent = message || "";
  $("retry-btn").hidden = !message;
}

function showApp() {
  $("boot").hidden = true;
  $("login-view").hidden = true;
  $("app").hidden = false;
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.hidden = state.me?.role !== "admin";
  });
  $("me-name").textContent = state.me?.displayName || "";
  syncChrome();
}

function syncChrome() {
  document.body.classList.toggle("thread-open", !!state.activeId && !state.admin);
  document.body.classList.toggle("has-active", !!state.activeId && !state.admin);
  document.body.classList.toggle("in-admin", state.admin);
  document.body.dataset.panel = state.panel;
  $("panel-chats").hidden = state.panel !== "chats";
  $("panel-people").hidden = state.panel !== "people";
  $("admin-view").hidden = !state.admin;
  $("chat-shell").hidden = state.admin;
  document.querySelectorAll(".side-tab").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.panel === state.panel));
  });
  const threadOn = !!state.activeId && !state.admin;
  $("thread").hidden = !threadOn;
  $("empty-thread").hidden = threadOn;
  const total = state.conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0);
  const badge = $("tab-unread");
  badge.hidden = total <= 0;
  badge.textContent = total > 99 ? "99+" : String(total);
  document.title = total > 0 ? `(${total}) Garh-Comn` : "Garh-Comn";
  try {
    sessionStorage.setItem("porch.view", JSON.stringify({
      admin: !!state.admin,
      panel: state.panel,
      activeId: state.activeId,
    }));
  } catch {
    // Private mode can refuse sessionStorage. The in-memory view still holds.
  }
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function dayKey(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  const start = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((start(today) - start(date)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function formatListTime(ts) {
  if (!ts) return "";
  const label = formatDay(ts);
  return label === "Today" ? formatTime(ts) : label;
}

function titleFor(conversation) {
  if (conversation.type === "group") return conversation.name || "Group";
  const other = conversation.members.find((member) => member.id !== state.me.id);
  return other ? other.displayName : "Deleted user";
}

function otherOf(conversation) {
  if (conversation.type !== "direct") return null;
  return conversation.members.find((member) => member.id !== state.me.id) || null;
}

function previewText(conversation) {
  const typing = typingLabel(conversation.id);
  if (typing) return typing;
  const message = conversation.lastMessage;
  if (!message) return "No messages yet";
  const who = message.senderId === state.me.id ? "You" : message.senderName;
  let text = message.body || "";
  if (!text && message.attachmentName) {
    text = (message.attachmentMime || "").startsWith("image/") ? "Photo" : message.attachmentName;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 80) text = `${text.slice(0, 79)}…`;
  return `${who}: ${text}`;
}

function typingLabel(conversationId) {
  const map = state.typing.get(conversationId);
  if (!map) return "";
  const now = Date.now();
  const names = [...map.values()].filter((entry) => entry.until > now).map((entry) => entry.name);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

function tickState(message, memberIds) {
  const relevant = (message.receipts || []).filter((receipt) => memberIds.includes(receipt.userId));
  if (!relevant.length) return "sent";
  if (relevant.every((receipt) => receipt.readAt)) return "read";
  if (relevant.every((receipt) => receipt.deliveredAt)) return "delivered";
  return "sent";
}

function tickHtml(kind) {
  const label = kind === "read" ? "Read" : kind === "delivered" ? "Delivered" : "Sent";
  const marks = kind === "sent" ? "✓" : "✓✓";
  return `<span class="ticks ${kind}" title="${label}">${marks}</span>`;
}

function setConn(kind, text) {
  const el = $("conn");
  el.className = `conn ${kind || ""}`;
  el.textContent = text;
}

function renderAddresses(target, rows) {
  target.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("span");
    empty.textContent = "No network address yet. Plug in USB Ethernet or join Wi-Fi.";
    target.append(empty);
    return;
  }
  for (const row of rows) {
    const chip = document.createElement(target.id === "admin-addresses" ? "div" : "div");
    chip.className = target.id === "admin-addresses" ? "address-card" : "address-chip";
    const label = document.createElement("span");
    label.className = "kind";
    label.textContent = row.label || "Network";
    const code = document.createElement("code");
    code.textContent = row.url;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-btn";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(row.url);
        toast(`Copied ${row.url}`);
      } catch {
        toast(row.url);
      }
    });
    chip.append(label, code, button);
    target.append(chip);
  }
}

async function refreshAddresses() {
  if (state.me?.role !== "admin") {
    $("address-strip").hidden = true;
    return;
  }
  try {
    const info = await api("/api/host-info");
    state.addresses = info.addresses || [];
  } catch {
    return;
  }
  const strip = $("address-strip");
  strip.hidden = state.admin;
  renderAddresses(strip, state.addresses);
  if (state.admin) renderAddresses($("admin-addresses"), state.addresses);
}

function renderChats() {
  const query = $("chat-search").value.trim().toLowerCase();
  const list = $("chat-list");
  list.replaceChildren();
  const rows = state.conversations.filter((conversation) => titleFor(conversation).toLowerCase().includes(query));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "fine";
    empty.textContent = "No chats yet.";
    list.append(empty);
    return;
  }
  for (const conversation of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `row${conversation.id === state.activeId ? " active" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    const other = otherOf(conversation);
    avatar.style.background = conversation.type === "group" ? "#e2a15a" : (other?.color || "#7c7468");
    avatar.textContent = initials(titleFor(conversation));
    if (other) {
      const dot = document.createElement("span");
      dot.className = `presence-dot${state.presence.has(other.id) ? " on" : ""}`;
      avatar.append(dot);
    }
    const text = document.createElement("span");
    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = titleFor(conversation);
    const preview = document.createElement("div");
    const typing = typingLabel(conversation.id);
    preview.className = `preview${typing ? " typing" : ""}`;
    preview.textContent = previewText(conversation);
    text.append(name, preview);
    const meta = document.createElement("span");
    meta.className = "row-meta";
    const time = document.createElement("span");
    time.textContent = formatListTime(conversation.updatedAt);
    meta.append(time);
    if (conversation.unreadCount > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(conversation.unreadCount);
      meta.append(badge);
    }
    button.append(avatar, text, meta);
    button.addEventListener("click", () => openConversation(conversation.id));
    list.append(button);
  }
}

function renderPeople() {
  const query = $("people-search").value.trim().toLowerCase();
  const list = $("people-list");
  list.replaceChildren();
  const people = state.people
    .filter((person) => person.id !== state.me.id)
    .filter((person) => `${person.displayName} ${person.username}`.toLowerCase().includes(query))
    .sort((a, b) => Number(state.presence.has(b.id)) - Number(state.presence.has(a.id)) || a.displayName.localeCompare(b.displayName));
  if (!people.length) {
    const empty = document.createElement("p");
    empty.className = "fine";
    empty.textContent = state.me.role === "admin"
      ? "No one else has an account yet. Create one in Admin."
      : "No one else is on Garh-Comn yet.";
    list.append(empty);
    return;
  }
  for (const person of people) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "person";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = person.color;
    avatar.textContent = initials(person.displayName);
    const dot = document.createElement("span");
    dot.className = `presence-dot${state.presence.has(person.id) ? " on" : ""}`;
    avatar.append(dot);
    const text = document.createElement("span");
    const name = document.createElement("div");
    name.className = "person-name";
    name.textContent = person.displayName;
    const sub = document.createElement("div");
    sub.className = "preview";
    sub.textContent = `@${person.username} · ${state.presence.has(person.id) ? "Online" : "Offline"}`;
    text.append(name, sub);
    button.append(avatar, text);
    button.addEventListener("click", () => startDirect(person.id));
    list.append(button);
  }
}

function renderUsers() {
  const list = $("user-list");
  list.replaceChildren();
  for (const user of state.people) {
    const card = document.createElement("article");
    card.className = "user-card";
    card.dataset.user = String(user.id);
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = user.color;
    avatar.textContent = initials(user.displayName);
    const body = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = user.displayName;
    const meta = document.createElement("p");
    meta.textContent = `@${user.username}`;
    const pills = document.createElement("p");
    const role = document.createElement("span");
    role.className = "pill";
    role.textContent = user.role === "admin" ? "Admin" : "Member";
    const status = document.createElement("span");
    status.className = `pill${state.presence.has(user.id) ? " on" : ""}`;
    status.textContent = user.disabled ? "Disabled" : state.presence.has(user.id) ? "Online" : "Offline";
    pills.append(role, document.createTextNode(" "), status);
    const actions = document.createElement("div");
    actions.className = "user-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn ghost slim";
    reset.dataset.action = "reset";
    reset.textContent = "Reset password";
    actions.append(reset);
    if (user.role !== "admin") {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn ghost slim";
      toggle.dataset.action = user.disabled ? "enable" : "disable";
      toggle.textContent = user.disabled ? "Enable" : "Disable";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger slim";
      remove.dataset.action = "delete";
      remove.textContent = "Delete";
      actions.append(toggle, remove);
    }
    const resetRow = document.createElement("div");
    resetRow.className = "reset-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "New password";
    input.autocomplete = "off";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn primary slim";
    save.dataset.action = "save-password";
    save.textContent = "Save";
    resetRow.append(input, save);
    body.append(title, meta, pills, actions, resetRow);
    card.append(avatar, body);
    list.append(card);
  }
}

function appendTextWithLinks(parent, text) {
  const pattern = /https?:\/\/[^\s]+/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(last, match.index)));
    const link = document.createElement("a");
    link.href = match[0];
    link.textContent = match[0];
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    parent.append(link);
    last = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(last)));
}

function renderMessages() {
  const scroller = $("messages");
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const stick = nearBottom || state.forceStick;
  state.forceStick = false;
  scroller.replaceChildren();
  const conversation = state.conversations.find((item) => item.id === state.activeId);
  if (!conversation) return;
  if (state.hasMore) {
    const older = document.createElement("button");
    older.type = "button";
    older.className = "btn ghost slim load-earlier";
    older.textContent = "Load earlier messages";
    older.addEventListener("click", loadEarlier);
    scroller.append(older);
  }
  let previous = null;
  const memberIds = conversation.members.map((member) => member.id).filter((id) => id !== state.me.id);
  for (const message of state.messages) {
    if (!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
      const pill = document.createElement("div");
      pill.className = "day-pill";
      pill.textContent = formatDay(message.createdAt);
      scroller.append(pill);
    }
    const mine = message.senderId === state.me.id;
    const clustered = previous
      && previous.senderId === message.senderId
      && message.createdAt - previous.createdAt < 5 * 60 * 1000
      && dayKey(previous.createdAt) === dayKey(message.createdAt);
    const row = document.createElement("div");
    row.className = `bubble-row ${mine ? "mine" : "theirs"}`;
    row.dataset.messageId = String(message.id);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (!mine && conversation.type === "group" && !clustered) {
      const sender = document.createElement("div");
      sender.className = "sender";
      sender.style.color = message.senderColor;
      sender.textContent = message.senderName;
      bubble.append(sender);
    }
    if (message.body) {
      const paragraph = document.createElement("p");
      appendTextWithLinks(paragraph, message.body);
      bubble.append(paragraph);
    }
    if (message.attachment) {
      if (message.attachment.mime.startsWith("image/")) {
        const image = document.createElement("img");
        image.className = "shot";
        image.alt = message.attachment.name;
        image.src = `/api/files/${message.attachment.id}`;
        image.addEventListener("click", () => {
          $("lightbox").hidden = false;
          $("lightbox").querySelector("img").src = image.src;
          $("lightbox").querySelector("img").alt = image.alt;
        });
        bubble.append(image);
      } else if (message.attachment.mime.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = `/api/files/${message.attachment.id}`;
        bubble.append(audio);
      } else {
        const link = document.createElement("a");
        link.className = "file-link";
        link.href = `/api/files/${message.attachment.id}`;
        link.textContent = message.attachment.name;
        bubble.append(link);
      }
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const time = document.createElement("span");
    time.textContent = formatTime(message.createdAt);
    meta.append(time);
    if (mine) meta.insertAdjacentHTML("beforeend", tickHtml(tickState(message, memberIds)));
    bubble.append(meta);
    row.append(bubble);
    scroller.append(row);
    previous = message;
  }
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function renderThreadHead() {
  const conversation = state.conversations.find((item) => item.id === state.activeId);
  if (!conversation) return;
  $("thread-title").textContent = titleFor(conversation);
  const info = $("group-info-btn");
  info.hidden = !(state.me?.role === "admin" && conversation.type === "group");
  const typing = typingLabel(conversation.id);
  if (typing) {
    $("thread-sub").textContent = typing;
    return;
  }
  if (conversation.type === "direct") {
    const other = otherOf(conversation);
    $("thread-sub").textContent = other && state.presence.has(other.id) ? "Online" : "Offline";
    return;
  }
  const online = conversation.members.filter((member) => state.presence.has(member.id)).length;
  $("thread-sub").textContent = `${conversation.members.length} people · ${online} online`;
}

function removeConversation(id, reason) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  const name = titleFor(conversation);
  state.conversations = state.conversations.filter((item) => item.id !== id);
  state.typing.delete(id);
  if (state.activeId === id) {
    state.activeId = null;
    state.messages = [];
    state.hasMore = false;
    sessionStorage.removeItem("porch.active");
  }
  closeModal();
  toast(reason === "removed" ? `You were removed from ${name}.` : `${name} was deleted.`);
  renderChats();
  renderMessages();
  syncChrome();
  if (state.admin) renderGroups();
}

function upsertConversation(conversation) {
  const index = state.conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) state.conversations[index] = conversation;
  else state.conversations.push(conversation);
  state.conversations.sort((a, b) => {
    if (a.isEveryone !== b.isEveryone) return a.isEveryone ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

async function reloadLists() {
  const [conversations, people] = await Promise.all([
    api("/api/conversations"),
    api(state.me.role === "admin" ? "/api/admin/users" : "/api/users"),
  ]);
  state.conversations = conversations.conversations;
  state.people = people.users;
  renderChats();
  renderPeople();
  if (state.admin) {
    renderUsers();
    renderGroups();
  }
  syncChrome();
}

async function openConversation(id, { rebuild = true } = {}) {
  state.activeId = id;
  state.admin = false;
  state.panel = "chats";
  sessionStorage.setItem("porch.active", String(id));
  state.readUpTo = 0;
  if (rebuild) await refreshThreadMessages();
  syncChrome();
  renderChats();
  renderThreadHead();
  renderMessages();
  await markActiveRead();
}

async function refreshThreadMessages() {
  if (!state.activeId) return;
  const data = await api(`/api/conversations/${state.activeId}/messages?limit=50`);
  state.messages = data.messages;
  state.hasMore = data.hasMore;
  state.forceStick = true;
}

async function loadEarlier() {
  const first = state.messages[0];
  if (!first) return;
  const scroller = $("messages");
  const beforeHeight = scroller.scrollHeight;
  const data = await api(`/api/conversations/${state.activeId}/messages?limit=50&before=${first.id}`);
  const known = new Set(state.messages.map((message) => message.id));
  state.messages = [...data.messages.filter((message) => !known.has(message.id)), ...state.messages];
  state.hasMore = data.hasMore;
  renderMessages();
  scroller.scrollTop = scroller.scrollHeight - beforeHeight;
}

async function markActiveRead() {
  if (!state.activeId || document.visibilityState === "hidden") return;
  const last = state.messages.at(-1);
  if (!last || last.id <= state.readUpTo) return;
  state.readUpTo = last.id;
  const conversation = state.conversations.find((item) => item.id === state.activeId);
  if (conversation) conversation.unreadCount = 0;
  try {
    await api(`/api/conversations/${state.activeId}/read`, {
      method: "POST",
      body: JSON.stringify({ messageId: last.id }),
    });
  } catch {
    // The next refresh will correct the unread count.
  }
  renderChats();
  syncChrome();
}

async function startDirect(userId) {
  const data = await api("/api/conversations", { method: "POST", body: JSON.stringify({ userId }) });
  upsertConversation(data.conversation);
  closeModal();
  await openConversation(data.conversation.id);
}

function closeModal() {
  const modal = $("modal");
  if (modal.open) modal.close();
  $("modal-body").replaceChildren();
}

function openModal(title, node) {
  const modal = $("modal");
  $("modal-title").textContent = title;
  $("modal-body").replaceChildren(node);
  if (!modal.open) modal.showModal();
}

function openNewChat() {
  const wrap = document.createElement("div");
  const search = document.createElement("input");
  search.placeholder = "Search people";
  search.setAttribute("aria-label", "Search people");
  const list = document.createElement("div");
  list.className = "check-list";
  const paint = () => {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const person of state.people.filter((item) => item.id !== state.me.id && !item.disabled)) {
      if (!`${person.displayName} ${person.username}`.toLowerCase().includes(query)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn ghost person-btn";
      button.textContent = `${person.displayName} · ${state.presence.has(person.id) ? "Online" : "Offline"}`;
      button.addEventListener("click", () => startDirect(person.id));
      list.append(button);
    }
  };
  search.addEventListener("input", paint);
  wrap.append(search, list);
  paint();
  openModal("New chat", wrap);
}

function openNewGroup(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const wrap = document.createElement("div");
  const name = document.createElement("input");
  name.placeholder = "Group name";
  name.maxLength = 40;
  name.setAttribute("aria-label", "Group name");
  const list = document.createElement("div");
  list.className = "check-list";
  const people = (state.people || []).filter((item) => item.id !== state.me.id && !item.disabled);
  if (!people.length) {
    const empty = document.createElement("p");
    empty.className = "fine";
    empty.textContent = "Create another account before starting a group.";
    list.append(empty);
  }
  for (const person of people) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(person.id);
    const text = document.createElement("span");
    text.textContent = person.displayName;
    label.append(box, text);
    list.append(label);
  }
  const notice = document.createElement("p");
  notice.className = "form-error";
  notice.hidden = true;
  const create = document.createElement("button");
  create.type = "button";
  create.className = "btn primary";
  create.textContent = "Create group";
  create.addEventListener("click", async () => {
    notice.hidden = true;
    const memberIds = [...list.querySelectorAll("input:checked")].map((box) => Number(box.value));
    if (!name.value.trim()) {
      notice.hidden = false;
      notice.textContent = "Enter a group name.";
      return;
    }
    if (!memberIds.length) {
      notice.hidden = false;
      notice.textContent = "Choose at least one other person.";
      return;
    }
    try {
      const data = await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ type: "group", name: name.value, memberIds }),
      });
      upsertConversation(data.conversation);
      closeModal();
      await openConversation(data.conversation.id);
    } catch (err) {
      notice.hidden = false;
      notice.textContent = err.message;
    }
  });
  wrap.append(name, list, notice, create);
  // Wait until this click finishes. Opening the dialog in the same click
  // lets Firefox deliver that click to the new top layer and dismiss it.
  setTimeout(() => openModal("New group", wrap), 0);
}

function openGroupInfo(conversation) {
  const wrap = document.createElement("div");
  const name = document.createElement("input");
  name.value = conversation.name || "";
  name.maxLength = 40;
  name.disabled = conversation.isEveryone;
  name.setAttribute("aria-label", "Group name");
  const list = document.createElement("div");
  list.className = "check-list";
  if (conversation.isEveryone) {
    const note = document.createElement("p");
    note.className = "fine";
    note.textContent = "Everyone includes every account. It cannot be renamed, edited, or deleted.";
    list.append(note);
  } else {
    const people = (state.people || []).filter((person) => {
      if (person.id === state.me.id) return false;
      return !person.disabled || conversation.members.some((member) => member.id === person.id);
    });
    for (const person of people) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = String(person.id);
      box.checked = conversation.members.some((member) => member.id === person.id);
      const text = document.createElement("span");
      text.textContent = person.displayName;
      label.append(box, text);
      list.append(label);
    }
  }
  const notice = document.createElement("p");
  notice.className = "form-error";
  notice.hidden = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.textContent = "Save";
  save.hidden = conversation.isEveryone;
  save.addEventListener("click", async () => {
    notice.hidden = true;
    const memberIds = [...list.querySelectorAll("input:checked")].map((box) => Number(box.value));
    if (!name.value.trim()) {
      notice.hidden = false;
      notice.textContent = "Enter a group name.";
      return;
    }
    if (!memberIds.length) {
      notice.hidden = false;
      notice.textContent = "Keep at least one other person.";
      return;
    }
    try {
      const data = await api(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.value, memberIds }),
      });
      upsertConversation(data.conversation);
      closeModal();
      renderChats();
      renderThreadHead();
      if (state.admin) renderGroups();
    } catch (err) {
      notice.hidden = false;
      notice.textContent = err.message;
    }
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn danger";
  remove.textContent = "Delete group";
  remove.hidden = conversation.isEveryone;
  remove.addEventListener("click", () => confirmDeleteGroup(conversation));
  wrap.append(name, list, notice, save, remove);
  setTimeout(() => openModal(conversation.name || "Group", wrap), 0);
}

function confirmDeleteGroup(conversation) {
  const wrap = document.createElement("div");
  const text = document.createElement("p");
  text.textContent = `Delete ${conversation.name}? This removes the group and its messages for everyone.`;
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeModal());
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "btn danger";
  yes.textContent = "Delete group";
  const notice = document.createElement("p");
  notice.className = "form-error";
  notice.hidden = true;
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    notice.hidden = true;
    try {
      await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      removeConversation(conversation.id, "deleted");
    } catch (err) {
      yes.disabled = false;
      notice.hidden = false;
      notice.textContent = err.message;
    }
  });
  actions.append(cancel, yes);
  wrap.append(text, notice, actions);
  setTimeout(() => openModal("Delete group", wrap), 0);
}

function renderGroups() {
  const list = $("group-list");
  if (!list) return;
  list.replaceChildren();
  const groups = state.conversations.filter((conversation) => conversation.type === "group");
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "fine";
    empty.textContent = "No groups yet.";
    list.append(empty);
    return;
  }
  for (const conversation of groups) {
    const card = document.createElement("article");
    card.className = "user-card";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = "#e2a15a";
    avatar.textContent = initials(titleFor(conversation));
    const body = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = titleFor(conversation);
    const meta = document.createElement("p");
    meta.textContent = conversation.isEveryone
      ? "Includes every account. This group cannot be deleted."
      : `${conversation.members.length} people`;
    const actions = document.createElement("div");
    actions.className = "user-actions";
    if (!conversation.isEveryone) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn ghost slim";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openGroupInfo(conversation));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger slim";
      remove.textContent = "Delete group";
      remove.addEventListener("click", () => confirmDeleteGroup(conversation));
      actions.append(edit, remove);
    }
    body.append(title, meta, actions);
    card.append(avatar, body);
    list.append(card);
  }
}

function applyIncoming(message) {
  let conversation = state.conversations.find((item) => item.id === message.conversationId);
  if (!conversation) {
    reloadLists().catch(() => {});
    return;
  }
  conversation.lastMessage = {
    id: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    body: message.body,
    createdAt: message.createdAt,
    attachmentName: message.attachment?.name || null,
    attachmentMime: message.attachment?.mime || null,
  };
  conversation.updatedAt = message.createdAt;
  const viewing = state.activeId === message.conversationId && !state.admin && document.visibilityState === "visible";
  if (message.senderId !== state.me.id && !viewing) conversation.unreadCount += 1;
  state.conversations.sort((a, b) => (a.isEveryone !== b.isEveryone ? (a.isEveryone ? -1 : 1) : b.updatedAt - a.updatedAt));
  if (state.activeId === message.conversationId && !state.messages.some((item) => item.id === message.id)) {
    state.messages.push(message);
    state.forceStick = message.senderId === state.me.id;
    renderMessages();
    if (viewing) markActiveRead();
  }
  renderChats();
  renderThreadHead();
  syncChrome();
}

function connectSocket() {
  if (!state.token || state.kicked) return;
  const previous = socket;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const mine = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  socket = mine;
  if (previous && previous !== mine) previous.close();
  mine.addEventListener("open", () => {
    if (socket !== mine) return;
    setConn("ok", "On this network");
    state.connected = true;
    const plan = planReconnect(state);
    reloadLists().then(async () => {
      if (socket !== mine) return;
      if (plan.admin) {
        state.admin = true;
        state.panel = "admin";
        renderUsers();
        renderGroups();
        syncChrome();
        return;
      }
      if (plan.refreshThread && state.conversations.some((conversation) => conversation.id === plan.activeId)) {
        await refreshThreadMessages();
        renderThreadHead();
        renderMessages();
        syncChrome();
      }
    }).catch(() => {});
  });
  socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === "ready") {
      state.presence = new Set(payload.presence || []);
      renderChats();
      renderPeople();
      renderThreadHead();
      if (state.admin) {
        renderUsers();
        renderGroups();
      }
    } else if (payload.type === "presence") {
      state.presence = new Set(payload.userIds || []);
      renderChats();
      renderPeople();
      renderThreadHead();
      if (state.admin) {
        renderUsers();
        renderGroups();
      }
    } else if (payload.type === "message") {
      applyIncoming(payload.message);
    } else if (payload.type === "conversation") {
      upsertConversation(payload.conversation);
      renderChats();
      if (state.activeId === payload.conversation.id) renderThreadHead();
      if (state.admin) renderGroups();
    } else if (payload.type === "conversation-removed") {
      removeConversation(payload.conversationId, payload.reason);
    } else if (payload.type === "typing") {
      if (payload.userId === state.me.id) return;
      let map = state.typing.get(payload.conversationId);
      if (!map) {
        map = new Map();
        state.typing.set(payload.conversationId, map);
      }
      if (payload.isTyping) map.set(payload.userId, { name: payload.displayName, until: Date.now() + 3500 });
      else map.delete(payload.userId);
      renderChats();
      renderThreadHead();
    } else if (payload.type === "read" || payload.type === "delivered") {
      const ids = new Set(payload.messageIds || []);
      for (const message of state.messages) {
        if (!ids.has(message.id)) continue;
        let receipt = message.receipts.find((item) => item.userId === payload.userId);
        if (!receipt) {
          receipt = { userId: payload.userId, deliveredAt: null, readAt: null };
          message.receipts.push(receipt);
        }
        if (payload.type === "delivered") receipt.deliveredAt = payload.deliveredAt;
        if (payload.type === "read") {
          receipt.readAt = payload.readAt;
          receipt.deliveredAt = receipt.deliveredAt || payload.readAt;
        }
      }
      if (state.activeId === payload.conversationId) renderMessages();
    } else if (payload.type === "kicked") {
      state.kicked = true;
      forceLogout(payload.reason || "Your session ended.");
    }
  });
  mine.addEventListener("close", () => {
    if (socket !== mine) return;
    state.connected = false;
    if (state.kicked) return;
    setConn("warn", "Reconnecting…");
    setTimeout(connectSocket, 1200);
  });
}

function sendTyping(isTyping) {
  if (!socket || socket.readyState !== 1 || !state.activeId) return;
  socket.send(JSON.stringify({ type: "typing", conversationId: state.activeId, isTyping }));
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $("composer-text").value.trim();
  if (!text && !state.file) return;
  if (text.length > 4000) {
    toast("That message is too long.");
    return;
  }
  if (state.file && state.file.size > state.maxUploadMb * 1024 * 1024) {
    toast(`That file is larger than ${state.maxUploadMb} MB.`);
    return;
  }
  const button = event.target.querySelector(".send");
  button.disabled = true;
  try {
    let body;
    let headers;
    if (state.file) {
      body = new FormData();
      body.append("body", text);
      body.append("file", state.file);
    } else {
      body = JSON.stringify({ body: text });
    }
    const data = await api(`/api/conversations/${state.activeId}/messages`, { method: "POST", body, headers });
    $("composer-text").value = "";
    $("composer-text").style.height = "auto";
    clearFile();
    sendTyping(false);
    typingSent = false;
    applyIncoming(data.message);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function clearFile() {
  state.file = null;
  $("file-input").value = "";
  $("file-chip").hidden = true;
  $("file-chip").replaceChildren();
}

function forceLogout(message) {
  state.token = "";
  state.me = null;
  localStorage.removeItem("porch.token");
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  clearInterval(addressTimer);
  showLogin(message);
}

function readSavedView() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("porch.view") || "null");
    if (!saved || typeof saved !== "object") return null;
    return saved;
  } catch {
    return null;
  }
}

async function boot() {
  showBoot();
  if (!state.token) {
    showLogin();
    return;
  }
  try {
    const me = await api("/api/me", { allow401: true });
    if (!me.user) {
      state.token = "";
      localStorage.removeItem("porch.token");
      showLogin();
      return;
    }
    state.me = me.user;
    state.maxUploadMb = me.maxUploadMb || 8;
    const savedView = readSavedView();
    if (savedView?.admin && state.me.role === "admin") {
      state.admin = true;
      state.panel = "admin";
      if (savedView.activeId) state.activeId = savedView.activeId;
    }
    showApp();
    connectSocket();
    await reloadLists();
    await refreshAddresses();
    addressTimer = setInterval(refreshAddresses, 5000);
    if (state.admin) {
      renderUsers();
      renderGroups();
      syncChrome();
    } else if (state.activeId && state.conversations.some((conversation) => conversation.id === state.activeId)) {
      await openConversation(state.activeId);
    } else {
      state.activeId = null;
      syncChrome();
    }
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin(error.message);
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").hidden = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      allow401: true,
      body: JSON.stringify({
        username: $("login-username").value,
        password: $("login-password").value,
      }),
    });
    state.token = data.token;
    state.kicked = false;
    state.me = data.user;
    state.maxUploadMb = data.maxUploadMb || 8;
    localStorage.setItem("porch.token", data.token);
    showApp();
    connectSocket();
    await reloadLists();
    await refreshAddresses();
    clearInterval(addressTimer);
    addressTimer = setInterval(refreshAddresses, 5000);
    const everyone = state.conversations.find((conversation) => conversation.isEveryone);
    if (everyone) await openConversation(everyone.id);
  } catch (error) {
    showLogin(error.message);
  }
});

$("retry-btn").addEventListener("click", boot);
$("toggle-password").addEventListener("click", () => {
  const input = $("login-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-password").textContent = show ? "Hide" : "Show";
});
$("logout-btn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch { /* already signed out */ }
  forceLogout();
});
$("admin-btn").addEventListener("click", () => {
  state.admin = true;
  state.panel = "admin";
  syncChrome();
  renderUsers();
  renderGroups();
  refreshAddresses();
});
$("admin-back").addEventListener("click", () => {
  state.admin = false;
  state.panel = "chats";
  syncChrome();
  if (state.activeId) {
    renderThreadHead();
    renderMessages();
  }
});
document.querySelectorAll("[data-panel]").forEach((button) => {
  button.addEventListener("click", () => {
    const panel = button.dataset.panel;
    if (panel === "admin") {
      state.admin = true;
      state.panel = "admin";
      renderUsers();
      renderGroups();
      refreshAddresses();
    } else {
      state.admin = false;
      state.panel = panel;
      if (panel === "chats") renderChats();
      if (panel === "people") renderPeople();
    }
    syncChrome();
  });
});
$("chat-search").addEventListener("input", renderChats);
$("people-search").addEventListener("input", renderPeople);
$("new-chat-btn").addEventListener("click", openNewChat);
$("new-group-btn").addEventListener("click", openNewGroup);
$("group-info-btn").addEventListener("click", () => {
  const conversation = state.conversations.find((item) => item.id === state.activeId);
  if (conversation) openGroupInfo(conversation);
});
$("back-btn").addEventListener("click", () => {
  state.activeId = null;
  sessionStorage.removeItem("porch.active");
  syncChrome();
  renderChats();
});
$("composer").addEventListener("submit", sendMessage);
$("composer-text").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
  if (!typingSent) {
    sendTyping(true);
    typingSent = true;
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    sendTyping(false);
    typingSent = false;
  }, 1500);
});
$("composer-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("attach-btn").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", () => {
  state.file = $("file-input").files[0] || null;
  const chip = $("file-chip");
  chip.replaceChildren();
  if (!state.file) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const name = document.createElement("span");
  name.textContent = `${state.file.name} · ${Math.ceil(state.file.size / 1024)} KB`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text-btn";
  remove.textContent = "Remove";
  remove.addEventListener("click", clearFile);
  chip.append(name, remove);
});
$("generate-password").addEventListener("click", () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  $("new-password").value = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  $("new-password").type = "text";
  $("new-password").select();
});
$("copy-password").addEventListener("click", async () => {
  const password = $("new-password").value;
  if (!password) return;
  try {
    await navigator.clipboard.writeText(password);
    toast("Password copied.");
  } catch {
    toast(password);
  }
});
$("create-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("create-error").hidden = true;
  try {
    const data = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        displayName: $("new-display").value,
        username: $("new-username").value,
        password: $("new-password").value,
      }),
    });
    $("create-note").hidden = false;
    $("create-note").textContent = `Account created for ${data.user.displayName}. Tell them the username and password. It is not shown again.`;
    $("new-display").value = "";
    $("new-username").value = "";
    await reloadLists();
    renderUsers();
  } catch (error) {
    $("create-error").hidden = false;
    $("create-error").textContent = error.message;
  }
});
$("user-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest("[data-user]");
  const id = Number(card.dataset.user);
  const action = button.dataset.action;
  try {
    if (action === "reset") {
      card.querySelector(".reset-row").classList.toggle("open");
      return;
    }
    if (action === "save-password") {
      const password = card.querySelector(".reset-row input").value;
      await api(`/api/admin/users/${id}/password`, { method: "POST", body: JSON.stringify({ password }) });
      toast("Password updated. They have been signed out.");
      card.querySelector(".reset-row").classList.remove("open");
      return;
    }
    if (action === "disable" || action === "enable") {
      await api(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: action === "disable" }),
      });
      await reloadLists();
      renderUsers();
      return;
    }
    if (action === "delete") {
      if (button.dataset.confirm !== "1") {
        button.dataset.confirm = "1";
        button.textContent = "Confirm delete";
        setTimeout(() => {
          button.dataset.confirm = "";
          button.textContent = "Delete";
        }, 4000);
        return;
      }
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      await reloadLists();
      renderUsers();
    }
  } catch (error) {
    toast(error.message);
  }
});
$("modal").addEventListener("click", (event) => {
  if (event.target === $("modal")) closeModal();
});
$("modal").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal();
});
$("lightbox").addEventListener("click", () => { $("lightbox").hidden = true; });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") markActiveRead();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const map of state.typing.values()) {
    for (const [id, entry] of map) {
      if (entry.until <= now) {
        map.delete(id);
        changed = true;
      }
    }
  }
  if (changed) {
    renderChats();
    renderThreadHead();
  }
}, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
