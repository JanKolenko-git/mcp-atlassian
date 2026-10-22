import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"

import { fakeHost, startServer, type Reply, type Seen } from "../shared/testing.ts"
import { fill, variablesOf } from "./templates.ts"

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
const storage =
  '<at:declarations><at:string at:name="Owner" /><at:textarea at:name="Notes" /></at:declarations>' +
  '<h2>Status</h2><p>Owner: <at:var at:name="Owner" /></p><at:var at:name="Notes" at:rawxhtml="true"></at:var><p><at:var at:name="Owner" /></p>'
const found = {
  templateId: "t1",
  name: "Weekly status",
  description: "One per week",
  templateType: "page",
  space: { key: "ENG" },
  body: { storage: { value: storage } },
}

test("fill replaces variables, escapes text unless raw, and names the ones left empty", () => {
  assert.deepEqual(variablesOf(storage), ["Owner", "Notes"])
  assert.deepEqual(fill(storage, { Owner: "Ana <ana@x>", Notes: "<p>raw</p>" }), {
    body: "<h2>Status</h2><p>Owner: Ana &lt;ana@x&gt;</p><p>raw</p><p>Ana &lt;ana@x&gt;</p>",
    empty: [],
  })
  assert.deepEqual(fill(storage, {}), { body: "<h2>Status</h2><p>Owner: </p><p></p>", empty: ["Owner", "Notes"] })
})

test("list_templates and get_template", async () => {
  routes = () => ({ body: { results: [found, { templateId: "t2", name: "Retro" }], size: 2 } })
  assert.equal((await call("list_templates", { space: "ENG" })).text, "t1  Weekly status  — One per week\nt2  Retro\nshowing 1–2")
  assert.equal(confluence.seen[0]?.url, "/rest/api/template/page?spaceKey=ENG&start=0&limit=50")
  await call("list_templates", { type: "blueprint" })
  assert.equal(confluence.seen[1]?.url, "/rest/api/template/blueprint?start=0&limit=50")

  routes = () => ({ body: found })
  assert.equal(
    (await call("get_template", { template_id: "t1" })).text,
    [
      "# Weekly status",
      "",
      "- **Template ID:** t1",
      "- **Type:** page in space ENG",
      "- **Description:** One per week",
      "- **Variables:** Owner, Notes",
      "",
      "---",
      "",
      "## Status",
      "",
      "Owner: {Owner}",
      "",
      "{Notes}",
      "",
      "{Owner}",
    ].join("\n"),
  )
  assert.equal(confluence.seen[2]?.url, "/rest/api/template/t1?expand=body")
  assert.match((await call("get_template", { template_id: "t1", format: "storage" })).text, /<at:var at:name="Owner" \/>/)
})

test("create_page_from_template fills the variables and creates the page under a parent", async () => {
  routes = (seen) =>
    seen.method === "POST" ? { body: { id: "900", title: "Status 2026-10-22", version: { number: 1 }, _links: { webui: "/x/900" } } } : { body: found }
  const made = await call("create_page_from_template", {
    template_id: "t1",
    space: "ENG",
    title: "Status 2026-10-22",
    parent: "42",
    variables: { Owner: "Ana" },
    labels: ["status"],
  })
  assert.equal(
    made.text,
    `Created "Status 2026-10-22" (900, v1) in ENG from template Weekly status with labels status. Left empty: Notes — ${confluence.url}/x/900`,
  )
  assert.deepEqual(body(1), {
    type: "page",
    title: "Status 2026-10-22",
    space: { key: "ENG" },
    ancestors: [{ id: "42" }],
    body: { storage: { value: "<h2>Status</h2><p>Owner: Ana</p><p>Ana</p>", representation: "storage" } },
  })
  assert.deepEqual([confluence.seen[2]?.url, body(2)], ["/rest/api/content/900/label", [{ prefix: "global", name: "status" }]])
})
