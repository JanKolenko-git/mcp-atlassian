import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"

import { fakeHost, startServer, type Reply, type Seen } from "../shared/testing.ts"

let routes: (seen: Seen) => Reply = () => ({ status: 404 })
const confluence = await fakeHost((seen) => routes(seen))
const { client, call } = await startServer(new URL("server.ts", import.meta.url), { CONFLUENCE_URL: confluence.url, CONFLUENCE_PERSONAL_TOKEN: "test-token" })

beforeEach(() => {
  confluence.seen.length = 0
})
after(async () => {
  await client.close()
  confluence.close()
})

const body = (index: number) => JSON.parse(confluence.seen[index]?.body ?? "null")
const pageInfo = { id: "42", title: "Spec", _links: { webui: "/x/42" } }
const restricted = (read: { users?: string[]; groups?: string[] }, update: { users?: string[]; groups?: string[] }) => ({
  read: {
    operation: "read",
    restrictions: {
      user: { results: (read.users ?? []).map((username) => ({ username })) },
      group: { results: (read.groups ?? []).map((name) => ({ name })) },
    },
  },
  update: {
    operation: "update",
    restrictions: {
      user: { results: (update.users ?? []).map((username) => ({ username })) },
      group: { results: (update.groups ?? []).map((name) => ({ name })) },
    },
  },
})

test("get_restrictions reads both operations", async () => {
  routes = (seen) => (seen.url.includes("/restriction/byOperation") ? { body: restricted({}, { users: ["ana"], groups: ["eng"] }) } : { body: pageInfo })
  assert.equal(
    (await call("get_restrictions", { page: "42" })).text,
    [
      `Restrictions on "Spec" (42) — ${confluence.url}/x/42`,
      "- read: unrestricted (everyone the space lets view)",
      "- update: only users ana; groups eng",
    ].join("\n"),
  )
  assert.equal(
    confluence.seen[1]?.url,
    "/rest/api/content/42/restriction/byOperation?expand=read.restrictions.user,read.restrictions.group,update.restrictions.user,update.restrictions.group",
  )
})

test("set_restrictions replaces the operations given, keeps the other, and keeps the token's user on edit", async () => {
  let state = restricted({}, { groups: ["eng"] })
  routes = (seen) => {
    if (seen.url.startsWith("/rest/api/user/current")) return { body: { username: "me" } }
    if (seen.method === "PUT") {
      const sent = JSON.parse(seen.body) as { operation: "read" | "update"; restrictions: { user: { username: string }[]; group: { name: string }[] } }[]
      const pick = (op: "read" | "update") => {
        const entry = sent.find((e) => e.operation === op)
        return { users: entry?.restrictions.user.map((u) => u.username), groups: entry?.restrictions.group.map((g) => g.name) }
      }
      state = restricted(pick("read"), pick("update"))
      return { body: {} }
    }
    if (seen.url.includes("/restriction/byOperation")) return { body: state }
    return { body: pageInfo }
  }
  const set = await call("set_restrictions", { page: "42", read: { groups: ["eng", "eng"] }, update: { users: ["ana"] } })
  assert.equal(
    set.text,
    [
      `Restrictions on "Spec" (42) — ${confluence.url}/x/42`,
      "- read: only groups eng",
      "- update: only users ana, me",
      "me was added to the edit restriction so this token keeps access.",
    ].join("\n"),
  )
  const put = confluence.seen.findIndex((s) => s.method === "PUT")
  assert.equal(confluence.seen[put]?.url, "/rest/api/content/42/restriction")
  assert.deepEqual(body(put), [
    { operation: "read", restrictions: { user: [], group: [{ type: "group", name: "eng" }] } },
    {
      operation: "update",
      restrictions: {
        user: [
          { type: "known", username: "ana" },
          { type: "known", username: "me" },
        ],
        group: [],
      },
    },
  ])

  confluence.seen.length = 0
  const lifted = await call("set_restrictions", { page: "42", update: { users: [] } })
  assert.match(lifted.text, /- read: only groups eng\n- update: unrestricted/)
  assert.ok(!confluence.seen.some((s) => s.url.startsWith("/rest/api/user/current")))
  assert.match((await call("set_restrictions", { page: "42" })).text, /Nothing to change/)
})

test("search_users: by CQL, falling back to the exact username", async () => {
  routes = () => ({
    body: { results: [{ user: { username: "ana", displayName: "Ana Novak", userKey: "k1" } }, { user: { username: "anatol", displayName: "Anatol" } }] },
  })
  assert.equal((await call("search_users", { query: "ana" })).text, "ana  Ana Novak  (key k1)\nanatol  Anatol")
  assert.equal(confluence.seen[0]?.url, "/rest/api/search?cql=type%3Duser%20AND%20user.fullname%20~%20%22ana%22&limit=10")

  routes = (seen) => (seen.url.startsWith("/rest/api/user?") ? { body: { username: "jdoe", displayName: "J. Doe" } } : { body: { results: [] } })
  assert.equal((await call("search_users", { query: "jdoe" })).text, "jdoe  J. Doe")
  assert.equal(confluence.seen[2]?.url, "/rest/api/user?username=jdoe")

  routes = (seen) => (seen.url.startsWith("/rest/api/user?") ? { status: 404, body: "" } : { body: { results: [] } })
  assert.equal((await call("search_users", { query: "nobody" })).text, "No user matches 'nobody'.")
})
