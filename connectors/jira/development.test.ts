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

const summary = {
  summary: {
    pullrequest: { overall: { count: 1 }, byInstanceType: { stash: { count: 1, name: "Bitbucket Server" } } },
    branch: { overall: { count: 1 }, byInstanceType: { stash: { count: 1, name: "Bitbucket Server" } } },
    repository: { overall: { count: 2 }, byInstanceType: { stash: { count: 2, name: "Bitbucket Server" } } },
  },
}
const instance = { name: "Bitbucket Server", type: "stash" }
const details: Record<string, unknown> = {
  pullrequest: {
    errors: [],
    detail: [
      {
        _instance: instance,
        pullRequests: [
          {
            id: "#12",
            name: "Fix cache",
            url: "https://git/pr/12",
            status: "MERGED",
            author: { name: "Ana" },
            lastUpdate: "2026-10-01T10:00:00.000+0000",
            source: { branch: "feature/cache" },
            destination: { branch: "main" },
            reviewers: [{ name: "Bob", approved: true }, { name: "Cy" }],
            commentCount: 3,
          },
        ],
      },
    ],
  },
  branch: {
    errors: [],
    detail: [
      {
        _instance: instance,
        branches: [
          {
            name: "feature/cache",
            url: "https://git/branch/feature-cache",
            repository: { name: "shop" },
            lastCommit: { displayId: "abc1234", authorTimestamp: "2026-10-01T09:30:00.000+0000" },
          },
        ],
      },
    ],
  },
  repository: {
    errors: [{ message: "GitHub token expired" }],
    detail: [
      {
        _instance: instance,
        repositories: [
          {
            name: "shop",
            commits: [
              {
                displayId: "abc1234",
                message: "Fix cache\n\nLonger body",
                author: { name: "Ana" },
                authorTimestamp: 1790847000000,
                url: "https://git/c/abc1234",
                files: [{}, {}],
              },
              { id: "def5678901", message: "WIP", author: { name: "Ana" }, authorTimestamp: 1790846000000, url: "https://git/c/def5678" },
            ],
          },
        ],
      },
    ],
  },
}

test("get_development_info: summary picks the instance types, details list PRs, branches and commits", async () => {
  routes = (seen) => {
    if (seen.url.startsWith("/rest/api/2/issue/")) return { body: { id: "10001", key: "PROJ-1" } }
    if (seen.url.startsWith("/rest/dev-status/1.0/issue/summary")) return { body: summary }
    const dataType = new URL(seen.url, "http://host").searchParams.get("dataType") ?? ""
    return { body: details[dataType] }
  }
  const info = await call("get_development_info", { key: "PROJ-1" })
  assert.equal(jira.seen[0]?.url, "/rest/api/2/issue/PROJ-1?fields=summary")
  assert.equal(queryOf(jira.seen, 1).get("issueId"), "10001")
  assert.deepEqual(
    jira.seen.slice(2).map((s) => [queryOf([s], 0).get("applicationType"), queryOf([s], 0).get("dataType")]),
    [
      ["stash", "pullrequest"],
      ["stash", "branch"],
      ["stash", "repository"],
    ],
  )
  assert.equal(
    info.text,
    [
      "PROJ-1 — development information (Bitbucket Server)",
      "",
      "Pull requests (1):",
      "  #12  MERGED  Fix cache  by Ana  updated 2026-10-01 10:00  feature/cache -> main  1/2 approved  3 comments  — https://git/pr/12",
      "",
      "Branches (1):",
      "  feature/cache  in shop  (last commit abc1234 2026-10-01 09:30)  — https://git/branch/feature-cache",
      "",
      "Commits (2):",
      "  abc1234  2026-10-01 09:30  Ana  Fix cache  [shop]  2 files  — https://git/c/abc1234",
      "  def5678  2026-10-01 09:13  Ana  WIP  [shop]  — https://git/c/def5678",
      "",
      "Errors from the integration: GitHub token expired",
    ].join("\n"),
  )
})

test("get_development_info: nothing linked, and no integration installed", async () => {
  routes = (seen) => (seen.url.startsWith("/rest/api/2/issue/") ? { body: { id: "10001" } } : { body: { summary: { pullrequest: { byInstanceType: {} } } } })
  assert.equal((await call("get_development_info", { key: "PROJ-1" })).text, "PROJ-1: no pull requests, branches or commits linked.")
  assert.equal(jira.seen.length, 2)

  routes = (seen) => (seen.url.startsWith("/rest/api/2/issue/") ? { body: { id: "10001" } } : { status: 404, body: "" })
  const missing = await call("get_development_info", { key: "PROJ-1" })
  assert.ok(missing.isError)
  assert.match(missing.text, /no repository integration .* is installed/)
})
