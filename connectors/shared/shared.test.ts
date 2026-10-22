import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { diffLines } from "./diff.ts"
import { readUpload } from "./files.ts"
import { connect, withQuery } from "./http.ts"
import { fakeHost, type Reply, type Seen } from "./testing.ts"
import { brief, pageFooter, quoted } from "./text.ts"
import { inlineToWiki, markdownToWiki } from "./wiki.ts"

test("withQuery: undefined left out, arrays repeated, commas kept readable", () => {
  assert.equal(withQuery("/x", { a: "b c", list: ["1", "2"], skip: undefined, n: 3, fields: "a,b" }), "/x?a=b%20c&list=1&list=2&n=3&fields=a,b")
  assert.equal(withQuery("/x?q=1", { a: "b" }), "/x?q=1&a=b")
  assert.equal(withQuery("/x", {}), "/x")
})

test("text helpers", () => {
  assert.equal(pageFooter(0, 20, 134), "showing 1–20 of 134; pass start=20 for more")
  assert.equal(pageFooter(20, 5, 25), "showing 21–25 of 25")
  assert.equal(pageFooter(0, 10, undefined, true), "showing 1–10; pass start=10 for more")
  assert.equal(pageFooter(0, 0, 0), "showing 0 of 0")
  assert.equal(brief({ displayName: "Ana", name: "ana" }), "Ana")
  assert.equal(brief([{ name: "x" }, { name: "y" }]), "x, y")
  assert.equal(brief(null), "—")
  assert.equal(brief([]), "—")
  assert.equal(brief(3), "3")
  assert.equal(quoted('say "hi" \\'), '"say \\"hi\\" \\\\"')
})

test("markdown to wiki: the everyday subset", () => {
  const markdown = [
    "# Title",
    "",
    "Some **bold** and *it* and `a *b*` and [l](http://x) ![i](http://p.png) ~~gone~~.",
    "",
    "- a",
    "  - b",
    "- c",
    "",
    "1. one",
    "2. two",
    "   - under two",
    "",
    "```js",
    "let x = 1; // **not bold**",
    "```",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | |",
    "",
    "> quote",
    "",
    "> two",
    "> lines",
    "",
    "---",
    "",
  ].join("\n")
  assert.equal(
    markdownToWiki(markdown),
    [
      "h1. Title",
      "",
      "Some *bold* and _it_ and {{a *b*}} and [l|http://x] !http://p.png! -gone-.",
      "",
      "* a",
      "** b",
      "* c",
      "",
      "# one",
      "# two",
      "#* under two",
      "",
      "{code:js}",
      "let x = 1; // **not bold**",
      "{code}",
      "",
      "||A||B||",
      "|1| |",
      "",
      "bq. quote",
      "",
      "{quote}",
      "two",
      "lines",
      "{quote}",
      "",
      "----",
      "",
    ].join("\n"),
  )
  assert.equal(inlineToWiki("2 * 3 * 4 and snake_case_name"), "2 * 3 * 4 and snake_case_name")
  assert.equal(markdownToWiki("- a\n\n- b\n\ntext"), "* a\n* b\n\ntext")
})

test("diffLines folds unchanged runs around the changes", () => {
  assert.equal(diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "a\nb\nc\nd\ne\nf\ng\nh\nX\nj", 1), "… 7 unchanged lines …\n  h\n- i\n+ X\n  j")
  assert.equal(diffLines("same", "same"), "(no changes)")
  assert.equal(diffLines("", "new"), "- \n+ new")
})

test("readUpload: absolute regular files under the cap, with a MIME type from the extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-upload-"))
  const file = join(dir, "app.LOG")
  await writeFile(file, "line")
  const upload = await readUpload(file, "Jira")
  assert.deepEqual([upload.name, upload.mimeType, upload.bytes.toString()], ["app.LOG", "text/plain", "line"])
  await assert.rejects(readUpload("relative/x.png", "Jira"), /not an absolute path/)
  await assert.rejects(readUpload(join(dir, "missing.png"), "Jira"), /no such file/)
  await assert.rejects(readUpload(dir, "Jira"), /is not a file/)
  process.env.CONFLUENCE_MAX_UPLOAD_MB = "0.000001"
  await assert.rejects(readUpload(file, "Confluence"), /over the 0.000001 MB upload cap/)
  delete process.env.CONFLUENCE_MAX_UPLOAD_MB
})

let routes: (seen: Seen) => Reply = () => ({ status: 404 })
const host = await fakeHost((seen) => routes(seen))
after(() => host.close())

test("connect: uploads are multipart with the anti-CSRF header, deletes carry no body", async () => {
  process.env.JIRA_URL = host.url
  process.env.JIRA_PERSONAL_TOKEN = "secret"
  const jira = connect("Jira")

  routes = () => ({ body: [{ id: "1" }] })
  await jira.upload("/rest/api/2/issue/K-1/attachments", { name: "shot.png", bytes: Buffer.from("png"), mimeType: "image/png" }, { comment: "hi" })
  const sent = host.seen.at(-1)
  assert.equal(sent?.method, "POST")
  assert.equal(sent?.headers["x-atlassian-token"], "no-check")
  assert.match(sent?.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/)
  assert.match(sent?.body ?? "", /name="file"; filename="shot.png"\r\nContent-Type: image\/png/)
  assert.match(sent?.body ?? "", /name="comment"\r\n\r\nhi/)

  routes = () => ({ status: 204, body: "" })
  assert.equal(await jira.sendJson("/rest/api/2/issue/K-1", undefined, "DELETE", { deleteSubtasks: true }), null)
  assert.equal(host.seen.at(-1)?.url, "/rest/api/2/issue/K-1?deleteSubtasks=true")
  assert.equal(host.seen.at(-1)?.headers["content-type"], undefined)

  routes = () => ({ status: 404 })
  await assert.rejects(jira.getJson("/rest/agile/1.0/board/1"), /Jira Software \(boards and sprints\) is not installed/)
  routes = () => ({ status: 413 })
  await assert.rejects(jira.getJson("/rest/api/2/x"), /HTTP 413 — the upload is larger than Jira accepts/)
  routes = () => ({ status: 429 })
  await assert.rejects(jira.getJson("/rest/api/2/x"), /HTTP 429 — Jira is rate limiting/)

  routes = () => ({ body: { version: "9.12.0" } })
  assert.equal(await jira.rawGet("/rest/api/2/serverInfo", { expand: "health" }), '{\n  "version": "9.12.0"\n}')
  assert.equal(host.seen.at(-1)?.url, "/rest/api/2/serverInfo?expand=health")
  await assert.rejects(jira.rawGet("/secure/Dashboard.jspa"), /not a REST path/)
})
