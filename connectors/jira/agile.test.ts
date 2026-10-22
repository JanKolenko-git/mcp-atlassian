import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"

import { fakeHost, queryOf, startServer, type Reply, type Seen } from "../shared/testing.ts"

let routes: (seen: Seen) => Reply = () => ({ status: 404 })
const jira = await fakeHost((seen) => routes(seen))
const { client, call } = await startServer(new URL("server.ts", import.meta.url), { JIRA_URL: jira.url, JIRA_PERSONAL_TOKEN: "test-token" })

beforeEach(() => {
  jira.seen.length = 0
})
after(async () => {
  await client.close()
  jira.close()
})

const body = (index: number) => JSON.parse(jira.seen[index]?.body ?? "null")

test("boards, sprints and epics are listed with the Agile footer", async () => {
  routes = () => ({ body: { isLast: false, total: 7, values: [{ id: 3, name: "ENG board", type: "scrum", location: { projectKey: "ENG" } }] } })
  assert.equal(
    (await call("list_boards", { project: "eng", type: "scrum", limit: 1 })).text,
    "3  ENG board  (scrum)  ENG\nshowing 1–1 of 7; pass start=1 for more",
  )
  assert.equal(jira.seen[0]?.url, "/rest/agile/1.0/board?projectKeyOrId=ENG&type=scrum&startAt=0&maxResults=1")

  routes = () => ({
    body: {
      isLast: true,
      values: [
        { id: 42, name: "Sprint 7", state: "active", startDate: "2026-10-06T08:00:00.000Z", endDate: "2026-10-20T08:00:00.000Z", goal: "Ship checkout" },
        { id: 43, name: "Sprint 8", state: "future" },
      ],
    },
  })
  assert.equal(
    (await call("list_sprints", { board: 3, state: ["active", "future"] })).text,
    "42  Sprint 7  [active]  2026-10-06 → 2026-10-20  — Ship checkout\n43  Sprint 8  [future]\nshowing 1–2",
  )
  assert.equal(queryOf(jira.seen, 1).get("state"), "active,future")

  routes = () => ({
    body: {
      isLast: true,
      values: [
        { key: "ENG-1", name: "Payments", done: false },
        { key: "ENG-2", summary: "Search", done: true },
      ],
    },
  })
  assert.equal((await call("list_epics", { board: 3, done: false })).text, "ENG-1  Payments  (open)\nENG-2  Search  (done)\nshowing 1–2")
  assert.equal(queryOf(jira.seen, 2).get("done"), "false")
})

test("get_sprint_issues: a sprint with its header, or a board backlog, never both", async () => {
  routes = (seen) =>
    seen.url === "/rest/agile/1.0/sprint/42"
      ? { body: { id: 42, name: "Sprint 7", state: "active" } }
      : { body: { total: 1, issues: [{ key: "ENG-9", fields: { summary: "Fix it", status: { name: "To Do" } } }] } }
  assert.equal(
    (await call("get_sprint_issues", { sprint: 42, jql: "assignee = currentUser()" })).text,
    `42  Sprint 7  [active]\n\nENG-9  [To Do]  Fix it  —  ${jira.url}/browse/ENG-9\nshowing 1–1 of 1`,
  )
  assert.equal(jira.seen[1]?.url, "/rest/agile/1.0/sprint/42/issue?jql=assignee%20%3D%20currentUser()&startAt=0&maxResults=50&fields=summary,status")

  await call("get_sprint_issues", { backlog_of_board: 3 })
  assert.equal(jira.seen[2]?.url, "/rest/agile/1.0/board/3/backlog?startAt=0&maxResults=50&fields=summary,status")
  assert.match((await call("get_sprint_issues", {})).text, /exactly one of `sprint` or `backlog_of_board`/)
  assert.match((await call("get_sprint_issues", { sprint: 1, backlog_of_board: 2 })).text, /exactly one of/)
})

test("moving and ranking", async () => {
  routes = () => ({ status: 204, body: "" })
  assert.equal((await call("move_issues", { issues: ["ENG-1", `${jira.url}/browse/ENG-2`], sprint: 42 })).text, "Moved ENG-1, ENG-2 to sprint 42.")
  assert.deepEqual([jira.seen[0]?.url, body(0)], ["/rest/agile/1.0/sprint/42/issue", { issues: ["ENG-1", "ENG-2"] }])
  assert.equal((await call("move_issues", { issues: ["ENG-1"], backlog: true })).text, "Moved ENG-1 to the backlog.")
  assert.equal(jira.seen[1]?.url, "/rest/agile/1.0/backlog/issue")
  assert.match((await call("move_issues", { issues: ["ENG-1"] })).text, /exactly one of `sprint` or `backlog: true`/)

  assert.equal((await call("rank_issue", { issues: ["ENG-1"], before: "ENG-5" })).text, "Ranked ENG-1 before ENG-5.")
  assert.equal(jira.seen[2]?.method, "PUT")
  assert.deepEqual(body(2), { issues: ["ENG-1"], rankBeforeIssue: "ENG-5" })
  assert.match((await call("rank_issue", { issues: ["ENG-1"] })).text, /exactly one of `before` or `after`/)
})

test("sprints are created and updated with Jira dates, partially", async () => {
  routes = () => ({ body: { id: 44, name: "Sprint 9", state: "future" } })
  assert.equal(
    (await call("create_sprint", { board: 3, name: "Sprint 9", start_date: "2026-11-01", goal: "g" })).text,
    'Created sprint 44 "Sprint 9" on board 3 [future].',
  )
  assert.deepEqual(body(0), { name: "Sprint 9", originBoardId: 3, startDate: "2026-11-01T00:00:00.000+0000", goal: "g" })

  routes = () => ({ body: { id: 44, state: "active" } })
  assert.equal(
    (await call("update_sprint", { sprint: 44, state: "active", end_date: "2026-11-15T00:00:00Z" })).text,
    "Updated sprint 44: endDate, state  [active].",
  )
  assert.equal(jira.seen[1]?.method, "POST")
  assert.deepEqual(body(1), { endDate: "2026-11-15T00:00:00.000+0000", state: "active" })
  assert.match((await call("update_sprint", { sprint: 44 })).text, /Nothing to change/)
})

test("versions are created and updated", async () => {
  routes = () => ({ body: { id: "10", name: "2.0" } })
  assert.equal((await call("create_version", { project: "eng", name: "2.0", release_date: "2026-12-01" })).text, "Created version 2.0 (id 10) in ENG.")
  assert.deepEqual(body(0), { project: "ENG", name: "2.0", releaseDate: "2026-12-01" })
  routes = () => ({ status: 200, body: { id: "10" } })
  assert.equal((await call("update_version", { id: "10", released: true })).text, "Updated version 10: released.")
  assert.deepEqual([jira.seen[1]?.method, jira.seen[1]?.url, body(1)], ["PUT", "/rest/api/2/version/10", { released: true }])
})
