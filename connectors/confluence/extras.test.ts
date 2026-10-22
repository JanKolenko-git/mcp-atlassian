import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

test("get_comments: footer, inline and replies, rendered as Markdown", async () => {
  routes = () => ({
    body: {
      results: [
        {
          id: "10",
          version: { by: { displayName: "Ana" }, when: "2026-10-01T10:00:00Z" },
          body: { view: { value: "<p>Looks <em>good</em></p>" } },
          extensions: { location: "footer" },
        },
        {
          id: "11",
          version: { by: { displayName: "Bob" }, when: "2026-10-01T11:00:00Z" },
          body: { view: { value: "<p>Agreed</p>" } },
          ancestors: [{ id: "10", type: "comment" }],
          extensions: { location: "footer" },
        },
        {
          id: "12",
          version: { by: { displayName: "Cy" }, when: "2026-10-02T09:00:00Z" },
          body: { view: { value: "<p>Typo</p>" } },
          extensions: { location: "inline", inlineProperties: { originalSelection: "teh" }, resolution: { status: "open" } },
        },
      ],
      size: 3,
    },
  })
  const read = await call("get_comments", { page: "42" })
  assert.equal(
    confluence.seen[0]?.url,
    "/rest/api/content/42/child/comment?expand=body.view,version,ancestors,extensions.location,extensions.inlineProperties,extensions.resolution&depth=all&location=footer&location=inline&location=resolved&start=0&limit=50",
  )
  assert.equal(
    read.text,
    [
      "### Ana — 2026-10-01 10:00 (comment 10)",
      "",
      "Looks *good*",
      "",
      "### Bob — 2026-10-01 11:00 (comment 11, reply to 10)",
      "",
      "Agreed",
      "",
      '### Cy — 2026-10-02 09:00 (comment 12, inline on "teh", open)',
      "",
      "Typo",
      "",
      "showing 1–3",
    ].join("\n"),
  )
  await call("get_comments", { page: "42", location: "inline" })
  assert.match(confluence.seen[1]?.url ?? "", /&location=inline&start=0/)
})

test("add_comment: on a page, or as a reply through the parent's container", async () => {
  routes = (seen) => (seen.method === "POST" ? { body: { id: "20" } } : { body: pageInfo })
  assert.equal((await call("add_comment", { page: "42", body: "Nice" })).text, `Commented on "Spec" (comment 20) — ${confluence.url}/x/42?focusedCommentId=20`)
  assert.deepEqual(body(0), { type: "comment", container: { id: "42", type: "page" }, body: { storage: { value: "Nice", representation: "storage" } } })

  routes = (seen) =>
    seen.method === "POST"
      ? { body: { id: "21" } }
      : seen.url.startsWith("/rest/api/content/20")
        ? { body: { id: "20", type: "comment", container: { id: "42" } } }
        : { body: pageInfo }
  confluence.seen.length = 0
  assert.equal(
    (await call("add_comment", { reply_to: "20", body: "Thanks" })).text,
    `Replied to comment 20 on "Spec" (comment 21) — ${confluence.url}/x/42?focusedCommentId=21`,
  )
  assert.equal(confluence.seen[0]?.url, "/rest/api/content/20?expand=container")
  assert.deepEqual(body(1), {
    type: "comment",
    container: { id: "42", type: "page" },
    ancestors: [{ id: "20" }],
    body: { storage: { value: "Thanks", representation: "storage" } },
  })
  assert.match((await call("add_comment", { body: "x" })).text, /exactly one of `page` or `reply_to`/)
})

test("set_labels adds, removes and reports the result", async () => {
  routes = (seen) => (seen.method === "GET" ? { body: { results: [{ name: "spec" }, { name: "reviewed" }] } } : { body: {} })
  assert.equal(
    (await call("set_labels", { page: "42", add: ["reviewed"], remove: ["draft"] })).text,
    "Labels on page 42: +reviewed, -draft. Now: spec, reviewed",
  )
  assert.deepEqual([confluence.seen[0]?.url, body(0)], ["/rest/api/content/42/label", [{ prefix: "global", name: "reviewed" }]])
  assert.deepEqual([confluence.seen[1]?.method, confluence.seen[1]?.url], ["DELETE", "/rest/api/content/42/label?name=draft"])
  assert.match((await call("set_labels", { page: "42" })).text, /Nothing to change/)
})

test("add_attachment uploads a new file, or a new version of one with the same name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-conf-"))
  const file = join(dir, "diagram.png")
  await writeFile(file, "png")
  const made = {
    id: "600",
    title: "diagram.png",
    metadata: { mediaType: "image/png" },
    extensions: { fileSize: 3 },
    _links: { download: "/download/attachments/42/diagram.png" },
  }

  routes = (seen) => (seen.method === "GET" ? { body: { results: [] } } : { body: { results: [made] } })
  assert.equal(
    (await call("add_attachment", { page: "42", path: file, comment: "v1" })).text,
    `Uploaded diagram.png (image/png, 3 B, id 600) on page 42 — ${confluence.url}/download/attachments/42/diagram.png`,
  )
  assert.equal(confluence.seen[0]?.url, "/rest/api/content/42/child/attachment?filename=diagram.png")
  assert.equal(confluence.seen[1]?.url, "/rest/api/content/42/child/attachment")
  assert.equal(confluence.seen[1]?.headers["x-atlassian-token"], "no-check")
  assert.match(confluence.seen[1]?.body ?? "", /name="comment"\r\n\r\nv1/)
  assert.match(confluence.seen[1]?.body ?? "", /name="minorEdit"\r\n\r\ntrue/)

  routes = (seen) => (seen.method === "GET" ? { body: { results: [{ id: "600" }] } } : { body: made })
  confluence.seen.length = 0
  assert.match((await call("add_attachment", { page: "42", path: file })).text, /^Replaced diagram\.png/)
  assert.equal(confluence.seen[1]?.url, "/rest/api/content/42/child/attachment/600/data")
})

test("whoami and confluence_get", async () => {
  routes = () => ({ body: { username: "ana", displayName: "Ana Novak", userKey: "abc123" } })
  assert.equal((await call("whoami", {})).text, `ana  Ana Novak  (key abc123)  — ${confluence.url}`)
  routes = () => ({ body: { key: "ENG" } })
  assert.equal((await call("confluence_get", { path: "/rest/api/space/ENG", query: { expand: "homepage" } })).text, '{\n  "key": "ENG"\n}')
  assert.equal(confluence.seen[1]?.url, "/rest/api/space/ENG?expand=homepage")
  assert.match((await call("confluence_get", { path: "/plugins/x" })).text, /not a REST path/)
})

test("add_comment with anchor: an inline comment on the nth occurrence of the text, refused when the text is absent", async () => {
  routes = (seen) =>
    seen.method === "POST"
      ? { body: { id: "30" } }
      : seen.url.includes("body.storage")
        ? { body: { ...pageInfo, body: { storage: { value: "<p>Use the cache.</p><p>The cache &amp; the <b>cache</b> again</p>" } } } }
        : { body: pageInfo }
  const inline = await call("add_comment", { page: "42", body: "Which cache?", anchor: "cache", occurrence: 3 })
  assert.equal(inline.text, `Commented inline at "cache" (occurrence 3 of 3) on "Spec" (comment 30) — ${confluence.url}/x/42?focusedCommentId=30`)
  const sent = body(1)
  assert.equal(sent.extensions.location, "inline")
  assert.match(sent.extensions.inlineProperties.markerRef, /^[0-9a-f-]{36}$/)
  delete sent.extensions.inlineProperties.markerRef
  assert.deepEqual(sent.extensions.inlineProperties, { originalSelection: "cache", numMatches: 3, matchIndex: 2 })

  assert.match((await call("add_comment", { page: "42", body: "x", anchor: "cache", occurrence: 4 })).text, /occurs 3 time\(s\).*occurrence 4 does not exist/)
  assert.match((await call("add_comment", { page: "42", body: "x", anchor: "nowhere" })).text, /'nowhere' is not on the page as plain text/)
  assert.match((await call("add_comment", { reply_to: "20", body: "x", anchor: "cache" })).text, /`anchor` goes with `page`/)
  assert.equal(confluence.seen.filter((s) => s.method === "POST").length, 1)
})
