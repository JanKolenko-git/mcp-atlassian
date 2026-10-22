import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"

import { fakeHost, queryOf, startServer, type Reply, type Seen } from "../shared/testing.ts"
import { DELETES, READS, WRITES } from "./catalog.ts"

let routes: (seen: Seen) => Reply = () => ({ status: 404 })
const jira = await fakeHost((seen) => routes(seen))
const elsewhere = await fakeHost(() => ({ body: "should never be reached" }))
const { client, call } = await startServer(new URL("server.ts", import.meta.url), { JIRA_URL: jira.url, JIRA_PERSONAL_TOKEN: "test-token" })

beforeEach(() => {
  jira.seen.length = 0
  elsewhere.seen.length = 0
})

after(async () => {
  await client.close()
  jira.close()
  elsewhere.close()
})

test("tools/list: 41 tools by default, deletes asking, closed schemas, tiers in the annotations", async () => {
  const { tools } = await client.listTools()
  assert.equal(tools.length, 41)
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READS, ...WRITES, ...DELETES].sort())
  for (const t of tools) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name)
    assert.equal(t.annotations?.openWorldHint, false, t.name)
    assert.equal(t.annotations?.readOnlyHint, READS.includes(t.name), t.name)
    assert.equal(t.annotations?.destructiveHint === true, DELETES.includes(t.name), t.name)
    assert.equal(t._meta?.["anthropic/requiresUserInteraction"] === true, DELETES.includes(t.name), t.name)
  }
  assert.equal(tools.find((t) => t.name === "watch_issue")?.annotations?.idempotentHint, true)
  assert.match(client.getInstructions() ?? "", /only on the user's word in chat/)
})

test("inputs are checked before any request", async () => {
  assert.match((await call("get_issue", { key: "PROJ-1", bogus: 1 })).text, /Unrecognized key: "bogus"/)
  assert.match((await call("get_issue", {})).text, /Invalid arguments for tool get_issue/)
  assert.match((await call("search_issues", { text: "x", limit: 101 })).text, /Invalid arguments for tool search_issues/)
  assert.match((await call("add_comment", { key: "PROJ-1", body: "  " })).text, /is empty: nothing to post/)
  assert.match((await call("search_issues", { jql: "a", text: "b" })).text, /exactly one of `jql` or `text`/)
  assert.match((await call("search_issues", {})).text, /exactly one of `jql` or `text`/)
  assert.match((await call("get_issue_fields", { project: "X" })).text, /Pass `project` and `type`/)
  assert.match((await call("jira_get", { path: "/secure/Dashboard.jspa" })).text, /not a REST path/)
  assert.equal(jira.seen.length, 0)
})

test("the token goes to the configured host only", async () => {
  routes = () => ({ body: { key: "PROJ-1", fields: { summary: "A ticket" } } })
  assert.match((await call("get_issue", { key: "PROJ-1" })).text, /^# PROJ-1 — A ticket/)
  assert.equal(jira.seen[0]?.authorization, "Bearer test-token")
  assert.equal(
    jira.seen[0]?.url,
    "/rest/api/2/issue/PROJ-1?fields=summary,description,comment,attachment,issuelinks,labels,priority,status,assignee,reporter,components,issuetype,created,updated,parent,subtasks,resolution,fixVersions,duedate",
  )

  const refused = await call("get_attachment", { url: `${elsewhere.url}/secure/attachment/1/x.png` })
  assert.ok(refused.isError)
  assert.match(refused.text, /refusing to send JIRA_PERSONAL_TOKEN/)
  assert.equal(elsewhere.seen.length, 0)
})

test("a redirect is followed on the same host and refused off it", async () => {
  routes = (seen) =>
    seen.url.startsWith("/rest/api/2/issue/PROJ-2/transitions")
      ? { body: { transitions: [] } }
      : { status: 302, headers: { location: "/rest/api/2/issue/PROJ-2/transitions" } }
  assert.match((await call("list_transitions", { key: "PROJ-9" })).text, /^PROJ-9: no transitions available/)
  assert.equal(jira.seen.length, 2)

  routes = () => ({ status: 302, headers: { location: `${elsewhere.url}/steal` } })
  assert.match((await call("get_issue", { key: "PROJ-3" })).text, /off http:\/\/127\.0\.0\.1:\d+\. The token is not sent there/)
  assert.equal(elsewhere.seen.length, 0)

  routes = () => ({ status: 302, headers: { location: "https://login.microsoftonline.com/common/oauth2" } })
  assert.match((await call("get_issue", { key: "PROJ-3" })).text, /Microsoft SSO login page/)
})

test("HTTP failures read as their cause", async () => {
  routes = () => ({ status: 401 })
  assert.match((await call("get_issue", { key: "PROJ-1" })).text, /401 — JIRA_PERSONAL_TOKEN was rejected/)
  routes = () => ({ headers: { "content-type": "text/html" }, body: "<html>login</html>" })
  assert.match((await call("get_issue", { key: "PROJ-1" })).text, /got an HTML page/)
  routes = () => ({ status: 400, body: { errors: { priority: "not on screen" } } })
  assert.match((await call("create_issue", { project: "proj", type: "Bug", summary: "s", priority: "X" })).text, /HTTP 400 — .*not on screen/)
  routes = () => ({ status: 404 })
  assert.match((await call("list_boards", {})).text, /Jira Software \(boards and sprints\) is not installed/)
})

test("get_issue: extra fields, the changelog, and comment and link ids", async () => {
  routes = () => ({
    body: {
      key: "PROJ-1",
      names: { customfield_10010: "Epic Link" },
      fields: {
        summary: "A ticket",
        customfield_10010: "PROJ-9",
        customfield_10020: null,
        issuelinks: [
          {
            id: "501",
            type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
            outwardIssue: { key: "PROJ-2", fields: { summary: "Other", status: { name: "Open" } } },
          },
        ],
        attachment: [{ id: "77", filename: "a.png", mimeType: "image/png", size: 10, content: `${jira.url}/secure/attachment/77/a.png` }],
        comment: { comments: [{ id: "9", author: { displayName: "Ana" }, created: "2026-10-01T10:00:00.000+0000", body: "hi" }] },
      },
      changelog: {
        histories: [
          {
            created: "2026-10-02T09:30:00.000+0000",
            author: { displayName: "Bob" },
            items: [{ field: "status", fromString: "Open", toString: "In Progress" }],
          },
        ],
      },
    },
  })
  const read = await call("get_issue", { key: "PROJ-1", fields: ["customfield_10010", "customfield_10020"], changelog: true })
  assert.equal(queryOf(jira.seen, 0).get("expand"), "changelog,names")
  assert.match(queryOf(jira.seen, 0).get("fields") ?? "", /,duedate,customfield_10010,customfield_10020$/)
  assert.match(read.text, /- blocks \*\*PROJ-2\*\* \(Open\) — Other {2}\(link 501\)/)
  assert.match(read.text, /a\.png \(image\/png, 10 B, id 77\)/)
  assert.match(read.text, /## Other fields\n\n- \*\*Epic Link \(customfield_10010\):\*\* PROJ-9\n/)
  assert.match(read.text, /### Ana — 2026-10-01 10:00 \(comment 9\)/)
  assert.match(read.text, /## History\n\n- 2026-10-02 09:30 {2}Bob: status: Open → In Progress/)
})

test("search: text is wrapped and scoped, paging in the footer, extra fields under each line", async () => {
  routes = () => ({
    body: { total: 1234, issues: [{ key: "PROJ-7", fields: { summary: "Checkout", status: { name: "Open" }, assignee: { displayName: "Ana" } } }] },
  })
  const found = await call("search_issues", { text: 'say "hi"', project: "PROJ", limit: 5, fields: ["assignee"] })
  const query = queryOf(jira.seen, 0)
  assert.equal(query.get("jql"), 'project = "PROJ" AND (text ~ "say \\"hi\\"") ORDER BY updated DESC')
  assert.equal(query.get("maxResults"), "5")
  assert.equal(query.get("startAt"), "0")
  assert.equal(query.get("fields"), "summary,status,assignee")
  assert.equal(found.text, `PROJ-7  [Open]  Checkout  —  ${jira.url}/browse/PROJ-7\n    assignee: Ana\nshowing 1–1 of 1,234; pass start=1 for more`)

  await call("search_issues", { jql: "project = X ORDER BY created ASC", project: "PROJ", start: 40 })
  assert.equal(queryOf(jira.seen, 1).get("jql"), "project = X ORDER BY created ASC")
  assert.equal(queryOf(jira.seen, 1).get("startAt"), "40")

  await call("search_issues", { text: "project kickoff", project: "ENG" })
  assert.equal(queryOf(jira.seen, 2).get("jql"), 'project = "ENG" AND (text ~ "project kickoff") ORDER BY updated DESC')
})

test("transition: matched against what the workflow offers, never guessed; resolution and comment ride along", async () => {
  const offered = [
    { id: "11", name: "Start", to: { name: "In Progress" } },
    { id: "21", name: "Review", to: { name: "Code Review" } },
    { id: "31", name: "Close", to: { name: "Closed" } },
  ]
  routes = (seen) => (seen.method === "GET" ? { body: { transitions: offered } } : { status: 204, body: "" })

  assert.equal((await call("transition_issue", { key: "PROJ-1", to: "review" })).text, 'PROJ-1 -> Code Review  (via "Review", id 21)')
  assert.deepEqual(JSON.parse(jira.seen[1]?.body ?? ""), { transition: { id: "21" } })

  await call("transition_issue", {
    key: "PROJ-1",
    to: "Closed",
    resolution: "Fixed",
    comment: "# Done\n\nShipped **it**",
    format: "markdown",
    fields: { customfield_1: "x" },
  })
  assert.deepEqual(JSON.parse(jira.seen[3]?.body ?? ""), {
    transition: { id: "31" },
    fields: { customfield_1: "x", resolution: { name: "Fixed" } },
    update: { comment: [{ add: { body: "h1. Done\n\nShipped *it*" } }] },
  })

  jira.seen.length = 0
  const unknown = await call("transition_issue", { key: "PROJ-1", to: "Deployed" })
  assert.ok(unknown.isError)
  assert.match(unknown.text, /no transition leads to 'Deployed'.*\n {2}11\tStart\t->\tIn Progress/s)
  assert.match((await call("transition_issue", { key: "PROJ-1", to: "o" })).text, /'o' matches more than one destination/)
  assert.match((await call("transition_issue", { key: "PROJ-1", to: "99" })).text, /no transition with id 99/)
  assert.equal(jira.seen.filter((s) => s.method === "POST").length, 0)
})

test("create: names become Jira shapes, the passthrough sits underneath, the epic goes to its custom field", async () => {
  routes = (seen) =>
    seen.url.startsWith("/rest/api/2/field")
      ? { body: [{ id: "customfield_10010", name: "Epic Link", schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" } }] }
      : { body: { key: "PROJ-55" } }
  const made = await call("create_issue", {
    project: "proj",
    type: "Bug",
    summary: "s",
    description: "- a\n- b",
    format: "markdown",
    priority: "Major",
    labels: ["x"],
    components: ["API"],
    fix_versions: ["1.2"],
    assignee: "ana",
    reporter: "bob",
    due: "2026-12-01",
    epic: "PROJ-9",
    parent: "PROJ-50",
    fields: { customfield_1: { value: "Opt" } },
  })
  assert.equal(made.text, `Created PROJ-55 — ${jira.url}/browse/PROJ-55`)
  assert.deepEqual(JSON.parse(jira.seen.at(-1)?.body ?? ""), {
    fields: {
      customfield_1: { value: "Opt" },
      summary: "s",
      description: "* a\n* b",
      priority: { name: "Major" },
      labels: ["x"],
      components: [{ name: "API" }],
      fixVersions: [{ name: "1.2" }],
      assignee: { name: "ana" },
      reporter: { name: "bob" },
      duedate: "2026-12-01",
      customfield_10010: "PROJ-9",
      project: { key: "PROJ" },
      issuetype: { name: "Bug" },
      parent: { key: "PROJ-50" },
    },
  })
})

test("create_issues: created keys and refusals, in the order given", async () => {
  routes = () => ({
    body: {
      issues: [{ key: "PROJ-60" }, { key: "PROJ-61" }],
      errors: [{ status: 400, failedElementNumber: 1, elementErrors: { errorMessages: [], errors: { priority: "bad" } } }],
    },
  })
  const made = await call("create_issues", {
    issues: [
      { project: "P", type: "Task", summary: "one" },
      { project: "P", type: "Task", summary: "two" },
      { project: "P", type: "Task", summary: "three" },
    ],
  })
  assert.equal(jira.seen[0]?.url, "/rest/api/2/issue/bulk")
  assert.equal(JSON.parse(jira.seen[0]?.body ?? "").issueUpdates.length, 3)
  assert.equal(
    made.text,
    ["Created 2 of 3", `✓ PROJ-60 — one — ${jira.url}/browse/PROJ-60`, "✗ 2. two — priority: bad", `✓ PROJ-61 — three — ${jira.url}/browse/PROJ-61`].join("\n"),
  )
})

test("edit: null unassigns, lists replace or add and remove but not both", async () => {
  routes = () => ({ status: 204, body: "" })
  assert.match(
    (await call("edit_issue", { key: "PROJ-1", assignee: null, add_labels: ["qa"], remove_components: ["Web"], add_fix_versions: ["2.0"] })).text,
    /^Updated PROJ-1: assignee, components, fixVersions, labels/,
  )
  assert.deepEqual(JSON.parse(jira.seen[0]?.body ?? ""), {
    fields: { assignee: null },
    update: { labels: [{ add: "qa" }], components: [{ remove: { name: "Web" } }], fixVersions: [{ add: { name: "2.0" } }] },
  })
  assert.match((await call("edit_issue", { key: "PROJ-1", labels: ["a"], remove_labels: ["b"] })).text, /contradictory/)
  assert.match((await call("edit_issue", { key: "PROJ-1", components: ["a"], add_components: ["b"] })).text, /contradictory/)
  assert.match((await call("edit_issue", { key: "PROJ-1" })).text, /Nothing to change/)
})

test("attachments come back as image or text content", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex")
  routes = (seen) =>
    seen.url.endsWith(".png")
      ? { headers: { "content-type": "image/png" }, body: png }
      : { headers: { "content-type": "application/octet-stream" }, body: "line one\nline two" }
  const image = await call("get_attachment", { url: `${jira.url}/secure/attachment/1/Screen+shot.png` })
  assert.equal(image.content[0]?.text, "Screen shot.png (image/png, 8 B)")
  assert.deepEqual(image.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" })
  assert.equal((await call("get_attachment", { url: "/secure/attachment/2/app.log" })).text, "app.log (application/octet-stream, 17 B)\n\nline one\nline two")
})
