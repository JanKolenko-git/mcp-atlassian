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

test("projects: listed with a filter, described with types, components, versions and statuses", async () => {
  routes = () => ({
    body: [
      { key: "ENG", name: "Engineering", projectTypeKey: "software", lead: { displayName: "Ana" } },
      { key: "OPS", name: "Operations", projectTypeKey: "business" },
    ],
  })
  assert.equal((await call("list_projects", { query: "eng" })).text, `ENG  Engineering  (software, lead Ana)  —  ${jira.url}/projects/ENG`)
  assert.equal(queryOf(jira.seen, 0).get("expand"), "lead,description")
  assert.equal((await call("list_projects", { query: "zzz" })).text, "No project matches 'zzz'.")

  routes = (seen) =>
    seen.url.endsWith("/statuses")
      ? { body: [{ name: "Bug", statuses: [{ name: "Open" }, { name: "Done" }] }] }
      : {
          body: {
            key: "ENG",
            name: "Engineering",
            projectTypeKey: "software",
            lead: { displayName: "Ana" },
            description: "All  the\nthings",
            issueTypes: [
              { id: "1", name: "Bug", description: "A defect" },
              { id: "5", name: "Sub-task", subtask: true },
            ],
            components: [{ name: "API", lead: { displayName: "Bob" } }],
            versions: [
              { id: "10", name: "1.0", released: true, releaseDate: "2026-01-01" },
              { id: "11", name: "1.1", released: false, releaseDate: "2026-12-01" },
              { id: "12", name: "0.9", archived: true },
            ],
          },
        }
  assert.equal(
    (await call("get_project", { project: "eng" })).text,
    [
      "# ENG — Engineering",
      "",
      "- **Type:** software",
      "- **Lead:** Ana",
      `- **URL:** ${jira.url}/projects/ENG`,
      "- **Description:** All the things",
      "",
      "## Issue types (2)",
      "",
      "- Bug (id 1) — A defect",
      "- Sub-task (id 5, subtask)",
      "",
      "## Components (1)",
      "",
      "- API — lead Bob",
      "",
      "## Versions (3)",
      "",
      "- 1.0 (id 10; released 2026-01-01)",
      "- 1.1 (id 11; unreleased, due 2026-12-01)",
      "- 0.9 (id 12; archived)",
      "",
      "## Statuses by issue type",
      "",
      "- Bug: Open, Done",
      "",
    ].join("\n"),
  )
})

test("get_issue_fields: the per-type create metadata, its pre-8.4 fallback, and the edit screen", async () => {
  const perType = {
    values: [
      { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
      { fieldId: "priority", name: "Priority", required: false, schema: { type: "priority" }, allowedValues: [{ name: "High" }, { name: "Low" }] },
      { fieldId: "customfield_1", name: "Team", required: true, schema: { type: "array", items: "option", custom: "x" }, allowedValues: [{ value: "Blue" }] },
    ],
  }
  routes = (seen) =>
    seen.url.endsWith("/issuetypes?maxResults=200")
      ? {
          body: {
            values: [
              { id: "10001", name: "Bug" },
              { id: "10002", name: "Story" },
            ],
          },
        }
      : { body: perType }
  const fields = await call("get_issue_fields", { project: "eng", type: "bug" })
  assert.deepEqual(
    jira.seen.map((s) => s.url),
    ["/rest/api/2/issue/createmeta/ENG/issuetypes?maxResults=200", "/rest/api/2/issue/createmeta/ENG/issuetypes/10001?maxResults=200"],
  )
  assert.equal(
    fields.text,
    [
      "# Fields to create a bug in ENG",
      "",
      "## Required",
      "",
      "- summary — Summary (string)",
      "- customfield_1 — Team (array of option, custom): Blue",
      "",
      "## Optional",
      "",
      "- priority — Priority (priority): High, Low",
    ].join("\n"),
  )
  assert.match((await call("get_issue_fields", { project: "eng", type: "Epic" })).text, /has no issue type 'Epic'. It offers: Bug, Story/)

  routes = (seen) =>
    seen.url.startsWith("/rest/api/2/issue/createmeta/")
      ? { status: 404 }
      : { body: { projects: [{ issuetypes: [{ fields: { summary: { name: "Summary", required: true, schema: { type: "string" } } } }] }] } }
  jira.seen.length = 0
  assert.match((await call("get_issue_fields", { project: "eng", type: "Bug" })).text, /## Required\n\n- summary — Summary \(string\)/)
  assert.equal(queryOf(jira.seen, 1).get("expand"), "projects.issuetypes.fields")
  assert.equal(queryOf(jira.seen, 1).get("issuetypeNames"), "Bug")

  routes = () => ({ body: { fields: { assignee: { name: "Assignee", required: false, schema: { type: "user" } } } } })
  jira.seen.length = 0
  assert.match((await call("get_issue_fields", { key: `${jira.url}/browse/ENG-4` })).text, /^# Fields editable on ENG-4\n/)
  assert.equal(jira.seen[0]?.url, "/rest/api/2/issue/ENG-4/editmeta")
})

test("list_fields filters by id or name", async () => {
  routes = () => ({
    body: [
      { id: "summary", name: "Summary", schema: { type: "string" } },
      { id: "customfield_10010", name: "Epic Link", custom: true, schema: { type: "any" } },
    ],
  })
  assert.equal((await call("list_fields", { query: "epic" })).text, "customfield_10010  Epic Link  (any, custom)")
  assert.equal((await call("list_fields", {})).text, "customfield_10010  Epic Link  (any, custom)\nsummary  Summary  (string)")
  // The field list is fetched once per process.
  assert.equal(jira.seen.length, 1)
})

test("users: searched, or narrowed to who may be assigned a ticket or a project", async () => {
  routes = () => ({
    body: [
      { name: "ana", displayName: "Ana Novak", emailAddress: "ana@x.io" },
      { name: "old", displayName: "Old Timer", active: false },
    ],
  })
  assert.equal((await call("search_users", { query: "an" })).text, "ana  Ana Novak  <ana@x.io>\nold  Old Timer  (inactive)")
  assert.equal(jira.seen[0]?.url, "/rest/api/2/user/search?username=an&maxResults=20")
  await call("search_users", { query: "an", assignable_to: "ENG-4", limit: 5 })
  assert.equal(jira.seen[1]?.url, "/rest/api/2/user/assignable/search?issueKey=ENG-4&username=an&maxResults=5")
  await call("search_users", { query: ".", assignable_to: "eng" })
  assert.equal(jira.seen[2]?.url, "/rest/api/2/user/assignable/search?project=ENG&username=.&maxResults=20")
  routes = () => ({ body: [] })
  assert.equal((await call("search_users", { query: "zz" })).text, "No user matches 'zz'.")
})

test("whoami and jira_get", async () => {
  routes = () => ({ body: { name: "ana", displayName: "Ana Novak", emailAddress: "ana@x.io", timeZone: "Europe/Ljubljana" } })
  assert.equal((await call("whoami", {})).text, `ana  Ana Novak  <ana@x.io>  — time zone Europe/Ljubljana  — ${jira.url}`)
  routes = () => ({ body: { version: "9.12.0" } })
  assert.equal((await call("jira_get", { path: "/rest/api/2/serverInfo", query: { expand: "health" } })).text, '{\n  "version": "9.12.0"\n}')
  assert.equal(jira.seen[1]?.url, "/rest/api/2/serverInfo?expand=health")
})
