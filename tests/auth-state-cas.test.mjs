import assert from "node:assert/strict";
import test from "node:test";

const authKey = "onstarvoice.auth";
const store = {
  [authKey]: {
    code: "encrypted-new-code",
    authMutationId: "mutation-new",
    verified: false,
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return {[key]: store[key] ?? null};
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(key) {
        delete store[key];
      },
    },
  },
};

const {updateAuth} = await import("../utils/storage.js?auth-state-cas");

test("a stale verification response cannot overwrite a newer auth mutation", async () => {
  const result = await updateAuth(
    {
      code: "encrypted-old-code",
      verified: true,
      captureAgent: {id: "old-agent", token: "old-token"},
    },
    {expectedMutationId: "mutation-old"},
  );

  assert.equal(result.accepted, false);
  assert.equal(store[authKey].code, "encrypted-new-code");
  assert.equal(store[authKey].captureAgent, undefined);
});

test("the current auth mutation can commit its verified snapshot", async () => {
  const result = await updateAuth(
    {
      verified: true,
      captureAgent: {id: "new-agent", token: "new-token"},
    },
    {expectedMutationId: "mutation-new"},
  );

  assert.equal(result.accepted, true);
  assert.equal(store[authKey].code, "encrypted-new-code");
  assert.equal(store[authKey].captureAgent.id, "new-agent");
});
