import assert from "node:assert/strict";
import test from "node:test";
import { planReconnect } from "../public/js/view.js";

test("a socket reconnect keeps the admin page and does not reopen a chat", () => {
  const plan = planReconnect({ admin: true, panel: "admin", activeId: 4 });
  assert.equal(plan.admin, true);
  assert.equal(plan.panel, "admin");
  assert.equal(plan.activeId, 4);
  assert.equal(plan.refreshThread, false);
});

test("a socket reconnect refreshes the open chat when admin is closed", () => {
  const plan = planReconnect({ admin: false, panel: "chats", activeId: 4 });
  assert.equal(plan.admin, false);
  assert.equal(plan.panel, "chats");
  assert.equal(plan.refreshThread, true);
});
