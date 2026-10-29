/** What to do when the socket connects again. The open chat must not replace Admin. */
export function planReconnect(state) {
  const admin = !!state.admin;
  const panel = admin ? "admin" : state.panel === "people" ? "people" : "chats";
  const activeId = state.activeId || null;
  return {
    admin,
    panel,
    activeId,
    refreshThread: !admin && !!activeId,
  };
}
