// Pages: reading, finding and walking them, their history, and the writes that create, change
// and move them, each body write with a preview that shows what changes.
import * as z from "zod"

import { diffLines } from "../shared/diff.ts"
import { reply, type Tool } from "../shared/registry.ts"
import { quoted } from "../shared/text.ts"
import {
  body,
  bodyFormat,
  confluence,
  currentPage,
  footer,
  header,
  type Json,
  pageLine,
  pageRef,
  pageUrl,
  person,
  resolvePageId,
  spaceRef,
  start,
  STORAGE,
  toStorage,
  when,
} from "./common.ts"
import { htmlToMarkdown } from "./markdown.ts"

// One body format per request: the other is fetched only when the first comes back empty.
const EXPAND = "version,space,ancestors,children.attachment,metadata.labels"

const markers = (name: string) => [`<!-- ${name} START -->`, `<!-- ${name} END -->`] as const
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The page body with `block` in place of the marked section, or appended when there is none.
 * Confluence has no append primitive: every update PUTs the whole body. So the section is
 * delimited by comment markers and only what sits between them changes. Two cases stop rather
 * than guess: only one marker present, and no markers but the heading already on the page,
 * where an edit in the Confluence editor probably stripped the comments.
 */
function splice(current: string, name: string, heading: string | undefined, block: string) {
  const [startMark, endMark] = markers(name)
  const i = current.indexOf(startMark)
  const j = current.indexOf(endMark)
  if (i !== -1 && j > i) {
    return { body: current.slice(0, i) + block + current.slice(j + endMark.length), replaced: current.slice(i, j + endMark.length) }
  }
  if (i !== -1 || j !== -1) {
    throw new Error(`the page contains only one of the two '${name}' markers, so the section boundaries are unclear. Fix the page by hand, then retry.`)
  }
  if (heading && new RegExp(escapeRegExp(heading), "i").test(current)) {
    throw new Error(
      `no '${name}' markers found, but a section headed '${heading}' is already on the page — the markers were probably ` +
        "stripped by an edit in the Confluence editor. Appending would duplicate it. Re-add the markers around that " +
        "section by hand, or pass a different `marker`.",
    )
  }
  return { body: `${current}${current.endsWith("\n") || !current ? "" : "\n"}${block}`, replaced: null }
}

const section = z.strictObject({
  page: pageRef,
  space: spaceRef,
  marker: z.string().describe("A stable section name, such as ticket-report:PROJ-4821"),
  heading: z.string().optional().describe("The section's visible heading, used to detect a copy made without markers"),
  content: z.string().regex(/\S/, "is empty: nothing to write").describe(`The section, ${STORAGE}`),
  format: bodyFormat,
})

async function planSection(input: z.infer<typeof section>) {
  const pageId = await resolvePageId(input.page, input.space)
  const page = await currentPage(pageId)
  const version: number = page.version.number
  const [startMark, endMark] = markers(input.marker)
  const block = `${startMark}\n${await toStorage(input.content, input.format)}\n${endMark}`
  return { pageId, page, version, block, ...splice(body(page, "storage"), input.marker, input.heading, block) }
}

const pageUpdate = z.strictObject({
  page: pageRef,
  space: spaceRef,
  expected_version: z.number().int().describe("The version number get_page showed. The update is refused when the page has moved on since"),
  body: z.string().optional().describe(`The whole new body, ${STORAGE}. Omitted keeps the current body`),
  format: bodyFormat,
  title: z.string().optional().describe("A new title"),
  parent: pageRef.optional().describe("Move the page under this one"),
  message: z.string().optional().describe("The version message shown in the page history"),
})

async function planPage(input: z.infer<typeof pageUpdate>) {
  if (input.body === undefined && input.title === undefined && input.parent === undefined) throw new Error("Nothing to change: pass body, title or parent.")
  const pageId = await resolvePageId(input.page, input.space)
  const page = await currentPage(pageId)
  const version: number = page.version.number
  if (version !== input.expected_version) {
    throw new Error(
      `"${page.title}" is at version ${version} (${when(page.version.when)} by ${person(page.version.by) ?? "?"}), not ${input.expected_version}. ` +
        "Re-read it with get_page, then apply the change to that version.",
    )
  }
  const converted = input.body !== undefined && input.format !== undefined && input.format !== "storage"
  const storage = input.body === undefined ? body(page, "storage") : await toStorage(input.body, input.format)
  const parentId = input.parent === undefined ? undefined : await resolvePageId(input.parent, page.space?.key)
  return { pageId, page, version, storage, converted, parentId, title: input.title ?? page.title }
}

/** The version list from the experimental endpoint every Data Center has, or the two the history endpoint gives. */
async function versionsOf(pageId: string, limit: number): Promise<Json[]> {
  try {
    const data = (await confluence.getJson(`/rest/experimental/content/${pageId}/version`, { limit })) as Json
    return data.results ?? []
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("HTTP 404"))) throw error
    const history = (await confluence.getJson(`/rest/api/content/${pageId}/history`, { expand: "lastUpdated,previousVersion" })) as Json
    return [history.lastUpdated, history.previousVersion].filter(Boolean)
  }
}

async function storageAt(pageId: string, version: number, current: Json): Promise<string> {
  if (version === current.version?.number) return body(current, "storage")
  const page = (await confluence.getJson(`/rest/api/content/${pageId}`, { status: "historical", version, expand: "body.storage" })) as Json
  return body(page, "storage")
}

const asMarkdown = (storage: string) => htmlToMarkdown(storage).trim()

export function registerPages(tool: Tool) {
  tool(
    "read",
    "get_page",
    {
      description:
        "Read a page: a metadata header with its attachments and their URLs, then the body. `view` (default) has macros " +
        "expanded and is converted to Markdown; `storage` is the raw XHTML, unconverted, for matching markup before a write. `version` reads an older version.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        format: z.enum(["view", "storage"]).optional().describe("view, the default, or storage"),
        version: z.number().int().min(1).optional().describe("A past version number, from get_page_history"),
        raw: z.boolean().optional().describe("Return the raw REST JSON instead"),
      }),
    },
    async ({ page, space, format = "view", version, raw }) => {
      const pageId = await resolvePageId(page, space)
      const historical = version === undefined ? {} : { status: "historical", version }
      const content = (await confluence.getJson(`/rest/api/content/${pageId}`, { expand: `body.${format},${EXPAND}`, ...historical })) as Json
      if (raw) return reply(JSON.stringify(content, null, 2))
      let used = format
      let source = body(content, format)
      if (!source.trim()) {
        const other = format === "view" ? "storage" : "view"
        const fallback = body((await confluence.getJson(`/rest/api/content/${pageId}`, { expand: `body.${other}`, ...historical })) as Json, other)
        if (fallback.trim()) [used, source] = [other, fallback]
      }
      // Storage is asked for to rewrite the page; converting it would drop every <ac:...> element.
      const rendered = used === "storage" ? source : htmlToMarkdown(source)
      const notes = [
        used === format ? "" : `\`${format}\` body was empty; showed the other format instead.`,
        version === undefined ? "" : `This is version ${version}, not the current page.`,
      ].filter(Boolean)
      return reply([...header(content, pageId, notes.join(" ") || undefined), "", "---", "", rendered].join("\n"))
    },
  )

  tool(
    "read",
    "search_pages",
    {
      description:
        "Find content by title or body text, or by a CQL query, exactly one of the two; newest first. One line per hit: id  [SPACE]  title  —  URL, then a footer with the total and the `start` for the next page.",
      inputSchema: z.strictObject({
        text: z.string().optional().describe("Text to find"),
        cql: z.string().optional().describe('A CQL query sent as written, such as label = "runbook" AND space = ENG ORDER BY created DESC'),
        space: z.string().optional().describe("With `text`: restrict to a space key, such as ENG"),
        type: z.enum(["page", "blogpost", "comment", "attachment"]).optional().describe("With `text`: the content type. Default page"),
        title_only: z.boolean().optional().describe("With `text`: match titles only, for fewer and sharper hits"),
        limit: z.number().int().min(1).max(100).optional().describe("Most hits to return. Default 10"),
        start,
      }),
    },
    async ({ text, cql, space, type, title_only, limit, start: from = 0 }) => {
      if ((text === undefined) === (cql === undefined)) throw new Error("Pass exactly one of `text` or `cql`.")
      if (cql !== undefined && (space || type || title_only)) throw new Error("With `cql`, put the space, type and title clauses inside the CQL.")
      let query = cql ?? ""
      if (text !== undefined) {
        const needle = quoted(text)
        const clauses = [`type=${type ?? "page"}`, title_only ? `title ~ ${needle}` : `(title ~ ${needle} OR text ~ ${needle})`]
        if (space) clauses.push(`space="${space}"`)
        query = `${clauses.join(" AND ")} ORDER BY lastmodified DESC`
      }
      const data = (await confluence.getJson("/rest/api/content/search", { cql: query, limit: limit ?? 10, start: from, expand: "space,version" })) as Json
      const results: Json[] = data.results ?? []
      if (!results.length) return reply(`No content matched${from ? ` from start=${from}` : ""}. (CQL: ${query})`)
      const line = (hit: Json) =>
        hit.type && hit.type !== "page" ? `${hit.id}  [${hit.space?.key ?? "?"}]  (${hit.type})  ${hit.title}  —  ${pageUrl(hit)}` : pageLine(hit)
      return reply([...results.map(line), footer(data, from, results.length)].join("\n"))
    },
  )

  tool(
    "read",
    "list_spaces",
    {
      description: "List spaces: KEY  Name  (global or personal)  —  URL. `query` keeps those whose key or name contains it.",
      inputSchema: z.strictObject({
        query: z.string().optional().describe("Part of a key or name"),
        type: z.enum(["global", "personal"]).optional(),
        status: z.enum(["current", "archived"]).optional().describe("Default: current"),
        limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
        start,
      }),
    },
    async ({ query, type, status, limit = 50, start: from = 0 }) => {
      const data = (await confluence.getJson("/rest/api/space", { type, status: status ?? "current", start: from, limit })) as Json
      const needle = query?.toLowerCase()
      const spaces: Json[] = (data.results ?? []).filter((s: Json) => !needle || `${s.key} ${s.name}`.toLowerCase().includes(needle))
      if (!spaces.length) return reply(query ? `No space matches '${query}' in this page of results.` : "No spaces.")
      const lines = spaces.map((s) => `${s.key}  ${s.name}  (${s.type ?? "?"})  —  ${confluence.baseUrl()}${s._links?.webui ?? `/display/${s.key}`}`)
      return reply([...lines, footer(data, from, (data.results ?? []).length)].join("\n"))
    },
  )

  tool(
    "read",
    "list_pages",
    {
      description:
        "List the pages of a space, by title: id  [SPACE]  title  —  URL. `title` keeps those containing it; `root_only` lists the top level of the page tree.",
      inputSchema: z.strictObject({
        space: z.string().describe("Space key, such as ENG"),
        title: z.string().optional().describe("Part of a title"),
        root_only: z.boolean().optional().describe("Only pages without a parent"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
        start,
      }),
    },
    async ({ space, title, root_only, limit = 25, start: from = 0 }) => {
      let data: Json
      if (root_only) {
        data = (await confluence.getJson(`/rest/api/space/${encodeURIComponent(space)}/content/page`, {
          depth: "root",
          start: from,
          limit,
          expand: "space",
        })) as Json
        if (title) data.results = (data.results ?? []).filter((p: Json) => String(p.title).toLowerCase().includes(title.toLowerCase()))
      } else {
        const cql = `type=page AND space=${quoted(space)}${title ? ` AND title ~ ${quoted(title)}` : ""} ORDER BY title ASC`
        data = (await confluence.getJson("/rest/api/content/search", { cql, start: from, limit, expand: "space" })) as Json
      }
      const pages: Json[] = data.results ?? []
      if (!pages.length) return reply(`No pages in ${space}${title ? ` with '${title}' in the title` : ""}${root_only ? " at the root" : ""}.`)
      return reply([...pages.map(pageLine), footer(data, from, pages.length)].join("\n"))
    },
  )

  tool(
    "read",
    "get_children",
    {
      description: "The pages under a page: its children, or the whole subtree to `depth` levels, as an indented list of title (id) — URL.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        depth: z.number().int().min(1).max(20).optional().describe("1 (default) for direct children, more for the subtree"),
        limit: z.number().int().min(1).max(500).optional().describe("Most pages to fetch. Default 100"),
        start,
      }),
    },
    async ({ page, space, depth = 1, limit = 100, start: from = 0 }) => {
      const pageId = await resolvePageId(page, space)
      if (depth === 1) {
        const data = (await confluence.getJson(`/rest/api/content/${pageId}/child/page`, { start: from, limit, expand: "version" })) as Json
        const children: Json[] = data.results ?? []
        if (!children.length) return reply(`Page ${pageId} has no child pages.`)
        return reply([...children.map((c) => `- ${c.title} (${c.id}) — ${pageUrl(c)}`), footer(data, from, children.length)].join("\n"))
      }
      const root = (await confluence.getJson(`/rest/api/content/${pageId}`, { expand: "ancestors" })) as Json
      const base = (root.ancestors ?? []).length
      const data = (await confluence.getJson(`/rest/api/content/${pageId}/descendant/page`, { start: from, limit, expand: "ancestors" })) as Json
      const nodes: Json[] = (data.results ?? []).filter((p: Json) => (p.ancestors ?? []).length - base <= depth)
      if (!nodes.length) return reply(`Page ${pageId} has no descendant pages.`)
      // Ancestors run from the top of the space down, so the last one is the direct parent.
      const byParent = new Map<string, Json[]>()
      for (const node of nodes) {
        const parent = String(node.ancestors?.at(-1)?.id ?? pageId)
        byParent.set(parent, [...(byParent.get(parent) ?? []), node])
      }
      const lines: string[] = []
      const seen = new Set<string>()
      const render = (parent: string, level: number) => {
        for (const node of (byParent.get(parent) ?? []).sort((a, b) => String(a.title).localeCompare(String(b.title)))) {
          seen.add(String(node.id))
          lines.push(`${"  ".repeat(level)}- ${node.title} (${node.id}) — ${pageUrl(node)}`)
          render(String(node.id), level + 1)
        }
      }
      render(pageId, 0)
      for (const node of nodes)
        if (!seen.has(String(node.id))) lines.push(`- ${node.title} (${node.id}) — ${pageUrl(node)}  (parent not in this page of results)`)
      return reply([...lines, footer(data, from, (data.results ?? []).length)].join("\n"))
    },
  )

  tool(
    "read",
    "get_page_history",
    {
      description:
        "The versions of a page, newest first: number, when, who, message. With `diff`, the change between two versions as a line diff of their Markdown renderings.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        limit: z.number().int().min(1).max(200).optional().describe("Most versions to list. Default 20"),
        diff: z
          .tuple([z.number().int().min(1), z.number().int().min(1)])
          .optional()
          .describe("Two version numbers to compare, older first"),
      }),
    },
    async ({ page, space, limit = 20, diff }) => {
      const pageId = await resolvePageId(page, space)
      const current = await currentPage(pageId)
      const versions = await versionsOf(pageId, limit)
      const lines = [`# ${current.title} — history (current v${current.version.number})`, ""]
      for (const v of versions)
        lines.push(`- v${v.number}  ${when(v.when)}  ${person(v.by) ?? "?"}${v.minorEdit ? "  (minor)" : ""}${v.message ? `  — ${v.message}` : ""}`)
      if (!versions.length) lines.push("_(no versions listed)_")
      if (diff) {
        const [a, b] = diff
        const [before, after] = await Promise.all([storageAt(pageId, a, current), storageAt(pageId, b, current)])
        lines.push("", `## v${a} → v${b}`, "", diffLines(asMarkdown(before), asMarkdown(after)))
      }
      return reply(`${lines.join("\n")}\n`)
    },
  )

  tool(
    "read",
    "preview_section_update",
    {
      description: "Show what update_section would write, without writing: the section as it would be written and the one it replaces, or why it would refuse.",
      inputSchema: section,
    },
    async (input) => {
      const plan = await planSection(input)
      const [verb, joiner] = plan.replaced === null ? ["append", "to"] : ["update", "on"]
      return reply(
        [
          `Would ${verb} '${input.marker}' ${joiner} "${plan.page.title}" (${plan.pageId}, v${plan.version} -> v${plan.version + 1})`,
          ...(plan.replaced === null ? [] : ["--- current section", plan.replaced]),
          "+++ new section",
          plan.block,
          pageUrl(plan.page),
        ].join("\n"),
      )
    },
  )

  tool(
    "read",
    "preview_page_update",
    {
      description:
        "Show what update_page would do, without writing: the title and parent changes, and a line diff of the body as Markdown. When the body was converted, the storage to be written follows.",
      inputSchema: pageUpdate,
    },
    async (input) => {
      const plan = await planPage(input)
      const lines = [`Would update "${plan.page.title}" (${plan.pageId}, v${plan.version} -> v${plan.version + 1})`]
      if (input.title !== undefined && input.title !== plan.page.title) lines.push(`title: ${plan.page.title} -> ${input.title}`)
      if (plan.parentId !== undefined) lines.push(`parent: -> ${plan.parentId}`)
      if (input.body !== undefined) lines.push("--- body, as Markdown", diffLines(asMarkdown(body(plan.page, "storage")), asMarkdown(plan.storage)))
      if (plan.converted) lines.push("--- storage to be written", plan.storage)
      lines.push(pageUrl(plan.page))
      return reply(lines.join("\n"))
    },
  )

  tool(
    "write",
    "update_section",
    {
      description:
        "Add or replace one marker-delimited section of a page, leaving the rest alone. The first run appends the " +
        "section; later runs replace only what sits between the markers. A 409 means the page changed since it was read.",
      inputSchema: section,
    },
    async (input) => {
      const plan = await planSection(input)
      const action = plan.replaced === null ? "appended" : "updated"
      // A 409 means the page moved between this read and the write; it is reported, never retried with a bumped number.
      await confluence.sendJson(
        `/rest/api/content/${plan.pageId}`,
        {
          id: plan.pageId,
          type: "page",
          title: plan.page.title,
          space: { key: plan.page.space?.key },
          body: { storage: { value: plan.body, representation: "storage" } },
          version: { number: plan.version + 1, message: `${input.marker} (${action} by agent)` },
        },
        "PUT",
      )
      return reply(
        `${action[0]?.toUpperCase()}${action.slice(1)} '${input.marker}' on "${plan.page.title}" (v${plan.version} -> v${plan.version + 1}) — ${pageUrl(plan.page)}`,
      )
    },
  )

  tool(
    "write",
    "create_page",
    {
      description: "Create a page in a space, at the top level or under a parent, with labels. Returns its id and link.",
      inputSchema: z.strictObject({
        space: z.string().describe("Space key, such as ENG"),
        title: z.string().describe("The title; unique within the space"),
        body: z.string().describe(`The body, ${STORAGE}`),
        format: bodyFormat,
        parent: pageRef.optional().describe("The page to create it under"),
        labels: z.array(z.string()).optional(),
      }),
    },
    async ({ space, title, body: content, format, parent, labels }) => {
      const parentId = parent === undefined ? undefined : await resolvePageId(parent, space)
      const made = (await confluence.sendJson(
        "/rest/api/content",
        {
          type: "page",
          title,
          space: { key: space },
          ...(parentId && { ancestors: [{ id: parentId }] }),
          body: { storage: { value: await toStorage(content, format), representation: "storage" } },
        },
        "POST",
      )) as Json | null
      if (!made?.id) return reply("Page created, but Confluence returned no id in the response.")
      if (labels?.length)
        await confluence.sendJson(
          `/rest/api/content/${made.id}/label`,
          labels.map((name) => ({ prefix: "global", name })),
          "POST",
        )
      return reply(
        `Created "${made.title ?? title}" (${made.id}, v${made.version?.number ?? 1}) in ${space}${labels?.length ? ` with labels ${labels.join(", ")}` : ""} — ${pageUrl(made)}`,
      )
    },
  )

  tool(
    "write",
    "update_page",
    {
      description:
        "Replace the whole body of a page, retitle it or move it under another page, as one new version. Needs the version get_page showed and refuses when the page " +
        "has moved on. For one section of a page, update_section is safer.",
      inputSchema: pageUpdate,
    },
    async (input) => {
      const plan = await planPage(input)
      await confluence.sendJson(
        `/rest/api/content/${plan.pageId}`,
        {
          id: plan.pageId,
          type: "page",
          title: plan.title,
          space: { key: plan.page.space?.key },
          ...(plan.parentId && { ancestors: [{ id: plan.parentId }] }),
          body: { storage: { value: plan.storage, representation: "storage" } },
          version: { number: plan.version + 1, message: input.message ?? "updated by agent" },
        },
        "PUT",
      )
      const changed = [input.body !== undefined && "body", input.title !== undefined && "title", plan.parentId !== undefined && "parent"].filter(Boolean)
      return reply(`Updated "${plan.title}" (${plan.pageId}, v${plan.version} -> v${plan.version + 1}): ${changed.join(", ")} — ${pageUrl(plan.page)}`)
    },
  )

  tool(
    "write",
    "move_page",
    {
      description: "Move a page under another page, or before or after a sibling, keeping its history.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        target: pageRef.describe("The new parent, or the sibling to sit next to"),
        position: z
          .enum(["append", "before", "after"])
          .optional()
          .describe("append (default) makes it the last child of `target`; before and after place it next to `target`"),
      }),
    },
    async ({ page, space, target, position = "append" }) => {
      const pageId = await resolvePageId(page, space)
      const targetId = await resolvePageId(target, space)
      await confluence.sendJson(`/rest/api/content/${pageId}/move/${position}/${targetId}`, undefined, "PUT")
      return reply(`Moved page ${pageId} ${position === "append" ? "under" : position} ${targetId}.`)
    },
  )

  tool(
    "write",
    "copy_page",
    {
      description:
        "Copy a page, with its labels and attachments, to a new title: under a parent page, at the top of a space, or by default next to the original. " +
        "Restrictions are copied only with `copy_restrictions`. Returns the copy's id and link.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        title: z.string().optional().describe('The copy\'s title. Default: "Copy of" the original'),
        parent: pageRef.optional().describe("The page to put the copy under. Default: the original's parent"),
        to_space: z.string().optional().describe("The space key to copy into, at its top level unless `parent` is given. Default: the original's space"),
        copy_attachments: z.boolean().optional().describe("Default true"),
        copy_labels: z.boolean().optional().describe("Default true"),
        copy_restrictions: z.boolean().optional().describe("Default false"),
      }),
    },
    async ({ page, space, title, parent, to_space, copy_attachments = true, copy_labels = true, copy_restrictions = false }) => {
      const pageId = await resolvePageId(page, space)
      const source = (await confluence.getJson(`/rest/api/content/${pageId}`, { expand: "space,ancestors,body.storage,metadata.labels" })) as Json
      const targetSpace: string = to_space ?? source.space?.key
      const parentId =
        parent !== undefined
          ? await resolvePageId(parent, targetSpace)
          : to_space === undefined
            ? (source.ancestors?.at(-1)?.id as string | undefined)
            : undefined
      const newTitle = title ?? `Copy of ${source.title}`
      let made: Json | null
      let note = ""
      try {
        made = (await confluence.sendJson(
          `/rest/api/content/${pageId}/copy`,
          {
            copyAttachments: copy_attachments,
            copyPermissions: copy_restrictions,
            copyProperties: true,
            copyLabels: copy_labels,
            copyCustomContents: true,
            destination: parentId ? { type: "parent_page", value: String(parentId) } : { type: "space", value: targetSpace },
            pageTitle: newTitle,
          },
          "POST",
        )) as Json | null
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("HTTP 404"))) throw error
        // An older Server has no copy endpoint: the body is created as a new page, labels after it.
        made = (await confluence.sendJson(
          "/rest/api/content",
          {
            type: "page",
            title: newTitle,
            space: { key: targetSpace },
            ...(parentId && { ancestors: [{ id: String(parentId) }] }),
            body: { storage: { value: body(source, "storage"), representation: "storage" } },
          },
          "POST",
        )) as Json | null
        const labels: string[] = copy_labels ? (source.metadata?.labels?.results ?? []).map((l: Json) => l.name) : []
        if (made?.id && labels.length)
          await confluence.sendJson(
            `/rest/api/content/${made.id}/label`,
            labels.map((name) => ({ prefix: "global", name })),
            "POST",
          )
        note = " This Confluence has no page copy endpoint, so the body and labels were copied as a new page; attachments and restrictions were not."
      }
      if (!made?.id) return reply(`Page copied, but Confluence returned no id in the response.${note}`)
      return reply(
        `Copied "${source.title}" (${pageId}) to "${made.title ?? newTitle}" (${made.id}) in ${targetSpace}${parentId ? ` under ${parentId}` : ""} — ${pageUrl(made)}${note}`,
      )
    },
  )

  tool(
    "delete",
    "delete_page",
    {
      description:
        "Move a page to the trash of its space. It stays restorable there by a space admin; this tool never purges. Only on the user naming this exact page.",
      inputSchema: z.strictObject({ page: pageRef, space: spaceRef }),
    },
    async ({ page, space }) => {
      const pageId = await resolvePageId(page, space)
      const current = (await confluence.getJson(`/rest/api/content/${pageId}`, { expand: "space" })) as Json
      await confluence.sendJson(`/rest/api/content/${pageId}`, undefined, "DELETE")
      return reply(
        `Moved "${current.title}" (${pageId}) to the trash of space ${current.space?.key ?? "?"}. A space admin can restore it from Space tools → Content Tools → Trash.`,
      )
    },
  )
}
