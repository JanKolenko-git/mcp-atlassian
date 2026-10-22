import assert from "node:assert/strict"
import { after, test } from "node:test"

import { fakeHost, startServer, type Reply, type Seen } from "../shared/testing.ts"
import { DELETES, READS, WRITES } from "./catalog.ts"

let routes: (seen: Seen) => Reply = () => ({ status: 204, body: "" })
const jira = await fakeHost((seen) => routes(seen))
const everything = await startServer(new URL("server.ts", import.meta.url), { JIRA_URL: jira.url, JIRA_PERSONAL_TOKEN: "t", JIRA_DELETE: "on" })
const trimmed = await startServer(new URL("server.ts", import.meta.url), {
  JIRA_URL: jira.url,
  JIRA_PERSONAL_TOKEN: "t",
  JIRA_WRITE: "ask",
  JIRA_DELETE: "on",
})

after(async () => {
  await everything.client.close()
  await trimmed.client.close()
  jira.close()
})

test("JIRA_DELETE=on offers the five delete tools without the ask marker", async () => {
  const { tools } = await everything.client.listTools()
  assert.equal(tools.length, 41)
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READS, ...WRITES, ...DELETES].sort())
  for (const t of tools) assert.equal(t._meta?.["anthropic/requiresUserInteraction"], undefined, t.name)

  routes = () => ({ status: 204, body: "" })
  assert.equal((await everything.call("delete_issue", { key: "PROJ-1", delete_subtasks: true })).text, "Deleted PROJ-1 and its subtasks.")
  assert.deepEqual([jira.seen[0]?.method, jira.seen[0]?.url], ["DELETE", "/rest/api/2/issue/PROJ-1?deleteSubtasks=true"])
  assert.equal((await everything.call("delete_comment", { key: "PROJ-1", comment_id: "7" })).text, "Deleted comment 7 from PROJ-1.")
  assert.equal(jira.seen[1]?.url, "/rest/api/2/issue/PROJ-1/comment/7")
  assert.equal((await everything.call("delete_worklog", { key: "PROJ-1", worklog_id: "8" })).text, "Deleted worklog 8 from PROJ-1.")
  assert.equal((await everything.call("delete_attachment", { attachment_id: "9" })).text, "Deleted attachment 9.")
  assert.equal(jira.seen[3]?.url, "/rest/api/2/attachment/9")
  assert.equal((await everything.call("unlink_issues", { link_id: "10" })).text, "Removed link 10.")
  assert.equal(jira.seen[4]?.url, "/rest/api/2/issueLink/10")
  assert.ok(jira.seen.every((s) => s.method === "DELETE"))
})

test("JIRA_WRITE=ask marks every write and nothing else", async () => {
  const { tools } = await trimmed.client.listTools()
  assert.equal(tools.length, 41)
  assert.deepEqual(
    tools
      .filter((t) => t._meta?.["anthropic/requiresUserInteraction"] === true)
      .map((t) => t.name)
      .sort(),
    [...WRITES].sort(),
  )
})

test("an instance without an Epic Link field files the epic as the parent", async () => {
  jira.seen.length = 0
  routes = (seen) => (seen.url.startsWith("/rest/api/2/field") ? { body: [{ id: "summary", name: "Summary" }] } : { body: { key: "PROJ-2" } })
  await trimmed.call("create_issue", { project: "PROJ", type: "Story", summary: "s", epic: "PROJ-1" })
  assert.deepEqual(JSON.parse(jira.seen.at(-1)?.body ?? ""), {
    fields: { summary: "s", parent: { key: "PROJ-1" }, project: { key: "PROJ" }, issuetype: { name: "Story" } },
  })
})

const placeholders = await startServer(new URL("server.ts", import.meta.url), {
  JIRA_URL: jira.url,
  JIRA_PERSONAL_TOKEN: "t",
  JIRA_READ: "${user_config.jira_read}",
  JIRA_WRITE: "${user_config.jira_write}",
  JIRA_DELETE: "${user_config.jira_delete}",
})
after(() => placeholders.client.close())

test("an unsubstituted plugin option falls back to its default: everything on, deletes asking", async () => {
  const { tools } = await placeholders.client.listTools()
  assert.equal(tools.length, 41)
  assert.deepEqual(
    tools.filter((t) => t._meta?.["anthropic/requiresUserInteraction"] === true).map((t) => t.name),
    DELETES,
  )
})
