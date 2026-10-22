// Around a ticket: comments, worklogs, attachments, watchers, and links to other issues and the web.
import * as z from "zod"

import { readUpload } from "../shared/files.ts"
import { reply, type Tool } from "../shared/registry.ts"
import { formatSize } from "../shared/text.ts"
import { asWiki, browseUrl, duration, format, jira, jiraDate, type Json, key, myself, parseKey, person, text, when, WIKI } from "./common.ts"

interface LinkType {
  id: string
  name: string
  inward: string
  outward: string
}

async function linkTypes(): Promise<LinkType[]> {
  const data = (await jira.getJson("/rest/api/2/issueLinkType")) as Json
  return data.issueLinkTypes ?? []
}

const describeLinkTypes = (types: LinkType[]) => types.map((t) => `  ${t.name}: "${t.outward}" / "${t.inward}"`).join("\n")

/** The link type for `wanted`, by name or by either phrase. An inward phrase flips the direction. */
export function resolveLinkType(types: LinkType[], wanted: string): { type: LinkType; flipped: boolean } {
  const target = wanted.trim().toLowerCase()
  const forward = types.find((t) => t.name.toLowerCase() === target) ?? types.find((t) => t.outward.toLowerCase() === target)
  if (forward) return { type: forward, flipped: false }
  const backward = types.find((t) => t.inward.toLowerCase() === target)
  if (backward) return { type: backward, flipped: true }
  throw new Error(`no link type '${wanted}'. Available, as name: "outward phrase" / "inward phrase":\n${describeLinkTypes(types)}`)
}

export function registerActivity(tool: Tool) {
  tool(
    "read",
    "get_attachment",
    {
      description:
        "Read an attachment by the URL get_issue lists: an image comes back as an image, a log or other text as text, any other type as its name and size.",
      inputSchema: z.strictObject({ url: z.string().describe("The attachment content URL, on the Jira host") }),
    },
    ({ url }) => jira.attachment(url),
  )

  tool(
    "read",
    "get_worklogs",
    {
      description: "List the work logged on a ticket, one line each: id, author, started, time spent, note; then the total.",
      inputSchema: z.strictObject({ key }),
    },
    async ({ key: target }) => {
      const issueKey = parseKey(target)
      const data = (await jira.getJson(`/rest/api/2/issue/${issueKey}/worklog`)) as Json
      const logs: Json[] = data.worklogs ?? []
      if (!logs.length) return reply(`${issueKey}: no work logged.`)
      const lines = logs.map(
        (log) => `${log.id}  ${person(log.author) ?? "?"}  ${when(log.started)}  ${log.timeSpent ?? "?"}${text(log.comment) ? `  — ${text(log.comment)}` : ""}`,
      )
      const total = logs.reduce((sum, log) => sum + Number(log.timeSpentSeconds ?? 0), 0)
      return reply([...lines, `Total: ${duration(total)} in ${logs.length} entries`].join("\n"))
    },
  )

  tool(
    "read",
    "list_link_types",
    {
      description: 'List the issue link types, one per line: name: "outward phrase" / "inward phrase", for link_issues.',
      inputSchema: z.strictObject({}),
    },
    async () => reply(describeLinkTypes(await linkTypes()).replace(/^ {2}/gm, "") || "No link types defined."),
  )

  tool(
    "read",
    "get_remote_links",
    {
      description: "List the web links on a ticket (pull requests, Confluence pages, other URLs): id, title, URL, relationship.",
      inputSchema: z.strictObject({ key }),
    },
    async ({ key: target }) => {
      const issueKey = parseKey(target)
      const links = (await jira.getJson(`/rest/api/2/issue/${issueKey}/remotelink`)) as Json[]
      if (!links?.length) return reply(`${issueKey}: no remote links.`)
      return reply(
        links
          .map((link) => `${link.id}  ${link.object?.title ?? "(untitled)"} — ${link.object?.url ?? "?"}${link.relationship ? `  (${link.relationship})` : ""}`)
          .join("\n"),
      )
    },
  )

  tool(
    "write",
    "add_comment",
    {
      description: `Add a comment to a ticket, ${WIKI}. Everyone on the ticket sees it: keep an automated one to a line or two, what happened rather than how.`,
      inputSchema: z.strictObject({
        key,
        body: z.string().regex(/\S/, "is empty: nothing to post").describe(`The comment, ${WIKI}`),
        format,
        visibility: z
          .strictObject({ type: z.enum(["group", "role"]), value: z.string() })
          .optional()
          .describe("Restrict who sees it: a group name or a project role name"),
      }),
    },
    async ({ key: target, body, format: how, visibility }) => {
      const issueKey = parseKey(target)
      const result = (await jira.sendJson(
        `/rest/api/2/issue/${issueKey}/comment`,
        { body: asWiki(body, how), ...(visibility && { visibility }) },
        "POST",
      )) as Json | null
      const id = result?.id ?? "?"
      return reply(`Commented on ${issueKey} (comment ${id}) — ${browseUrl(issueKey)}?focusedCommentId=${id}`)
    },
  )

  tool(
    "write",
    "edit_comment",
    {
      description: "Replace the text of an existing comment. get_issue shows each comment's id.",
      inputSchema: z.strictObject({
        key,
        comment_id: z.string().describe("The comment id"),
        body: z.string().regex(/\S/, "is empty").describe(`The new text, ${WIKI}`),
        format,
      }),
    },
    async ({ key: target, comment_id, body, format: how }) => {
      const issueKey = parseKey(target)
      await jira.sendJson(`/rest/api/2/issue/${issueKey}/comment/${comment_id}`, { body: asWiki(body, how) }, "PUT")
      return reply(`Edited comment ${comment_id} on ${issueKey} — ${browseUrl(issueKey)}?focusedCommentId=${comment_id}`)
    },
  )

  tool(
    "write",
    "add_worklog",
    {
      description: "Log time on a ticket, and say how the remaining estimate changes.",
      inputSchema: z.strictObject({
        key,
        time_spent: z.string().describe("Time spent, as Jira writes it: 2h, 30m, 1d 4h"),
        started: z.string().optional().describe("When the work started, ISO 8601. Default: now"),
        comment: z.string().optional().describe(`A note on the work, ${WIKI}`),
        format,
        adjust: z
          .enum(["auto", "leave", "new", "manual"])
          .optional()
          .describe(
            "The remaining estimate: auto (default) subtracts the time spent, leave keeps it, new sets it to `estimate`, manual reduces it by `estimate`",
          ),
        estimate: z.string().optional().describe("With adjust new or manual: the new remaining estimate, or the amount to reduce it by"),
      }),
    },
    async ({ key: target, time_spent, started, comment, format: how, adjust, estimate }) => {
      if ((adjust === "new" || adjust === "manual") && !estimate) throw new Error(`adjust: ${adjust} needs \`estimate\`.`)
      const issueKey = parseKey(target)
      const result = (await jira.sendJson(
        `/rest/api/2/issue/${issueKey}/worklog`,
        { timeSpent: time_spent, started: started ? jiraDate(started) : undefined, comment: comment ? asWiki(comment, how) : undefined },
        "POST",
        { adjustEstimate: adjust, newEstimate: adjust === "new" ? estimate : undefined, reduceBy: adjust === "manual" ? estimate : undefined },
      )) as Json | null
      return reply(`Logged ${result?.timeSpent ?? time_spent} on ${issueKey} (worklog ${result?.id ?? "?"}) — ${browseUrl(issueKey)}`)
    },
  )

  tool(
    "write",
    "add_attachment",
    {
      description: "Upload a file from this machine to a ticket. Pass the absolute path; the size cap is the product's own default unless configured.",
      inputSchema: z.strictObject({ key, path: z.string().describe("Absolute path of the file to upload") }),
    },
    async ({ key: target, path }) => {
      const issueKey = parseKey(target)
      const file = await readUpload(path, "Jira")
      const made = ((await jira.upload(`/rest/api/2/issue/${issueKey}/attachments`, file)) as Json[] | null)?.[0]
      return reply(
        `Attached ${made?.filename ?? file.name} (${made?.mimeType ?? file.mimeType}, ${formatSize(made?.size ?? file.bytes.length)}, id ${made?.id ?? "?"}) to ${issueKey} — ${made?.content ?? browseUrl(issueKey)}`,
      )
    },
  )

  tool(
    "write",
    "watch_issue",
    {
      description: "Start or stop watching a ticket, for the token's user or a named one.",
      inputSchema: z.strictObject({
        key,
        watch: z.boolean().optional().describe("true (default) to watch, false to stop"),
        username: z.string().optional().describe("Whose watch to change. Default: the token's user"),
      }),
      idempotent: true,
    },
    async ({ key: target, watch, username }) => {
      const issueKey = parseKey(target)
      const who = username ?? (await myself())
      if (watch !== false) {
        // The body is the bare username as a JSON string, as Jira specifies it.
        await jira.sendJson(`/rest/api/2/issue/${issueKey}/watchers`, who, "POST")
        return reply(`${who} now watches ${issueKey}`)
      }
      await jira.sendJson(`/rest/api/2/issue/${issueKey}/watchers`, undefined, "DELETE", { username: who })
      return reply(`${who} no longer watches ${issueKey}`)
    },
  )

  tool(
    "write",
    "link_issues",
    {
      description:
        'Link two tickets. Read it as "`from` <outward phrase> `to`": type Blocks with from A and to B means A blocks B. ' +
        "Pass the type by name (Blocks, Relates, Duplicate, Cloners) or by phrase (blocks, is blocked by); an inward phrase swaps the two keys for you.",
      inputSchema: z.strictObject({
        type: z.string().describe("Link type name or phrase; list_link_types shows them"),
        from: key.describe("The ticket the phrase is read from"),
        to: key.describe("The other ticket"),
        comment: z.string().optional().describe(`A comment posted on \`from\` with the link, ${WIKI}`),
        format,
      }),
    },
    async (input) => {
      const { type, flipped } = resolveLinkType(await linkTypes(), input.type)
      const [inward, outward] = flipped ? [parseKey(input.to), parseKey(input.from)] : [parseKey(input.from), parseKey(input.to)]
      await jira.sendJson(
        "/rest/api/2/issueLink",
        {
          type: { name: type.name },
          inwardIssue: { key: inward },
          outwardIssue: { key: outward },
          ...(input.comment && { comment: { body: asWiki(input.comment, input.format) } }),
        },
        "POST",
      )
      return reply(`${inward} ${type.outward} ${outward}  (${type.name})`)
    },
  )

  tool(
    "write",
    "add_remote_link",
    {
      description: "Add a web link to a ticket: a pull request, a Confluence page, a dashboard. Shown in the ticket's Links section.",
      inputSchema: z.strictObject({
        key,
        url: z.string().url().describe("The address"),
        title: z.string().describe("The text shown for it"),
        summary: z.string().optional().describe("A line under the title"),
        relationship: z.string().optional().describe('How it relates, such as "fixed by" or "documented in"'),
      }),
    },
    async ({ key: target, url, title, summary, relationship }) => {
      const issueKey = parseKey(target)
      const result = (await jira.sendJson(`/rest/api/2/issue/${issueKey}/remotelink`, { object: { url, title, summary }, relationship }, "POST")) as Json | null
      return reply(`Linked ${title} to ${issueKey} (remote link ${result?.id ?? "?"}) — ${browseUrl(issueKey)}`)
    },
  )

  tool(
    "delete",
    "delete_comment",
    { description: "Delete a comment for good. get_issue shows each comment's id.", inputSchema: z.strictObject({ key, comment_id: z.string() }) },
    async ({ key: target, comment_id }) => {
      const issueKey = parseKey(target)
      await jira.sendJson(`/rest/api/2/issue/${issueKey}/comment/${comment_id}`, undefined, "DELETE")
      return reply(`Deleted comment ${comment_id} from ${issueKey}.`)
    },
  )

  tool(
    "delete",
    "delete_worklog",
    { description: "Delete a worklog entry for good. get_worklogs shows the ids.", inputSchema: z.strictObject({ key, worklog_id: z.string() }) },
    async ({ key: target, worklog_id }) => {
      const issueKey = parseKey(target)
      await jira.sendJson(`/rest/api/2/issue/${issueKey}/worklog/${worklog_id}`, undefined, "DELETE")
      return reply(`Deleted worklog ${worklog_id} from ${issueKey}.`)
    },
  )

  tool(
    "delete",
    "delete_attachment",
    { description: "Delete an attachment for good. get_issue shows each attachment's id.", inputSchema: z.strictObject({ attachment_id: z.string() }) },
    async ({ attachment_id }) => {
      await jira.sendJson(`/rest/api/2/attachment/${attachment_id}`, undefined, "DELETE")
      return reply(`Deleted attachment ${attachment_id}.`)
    },
  )

  tool(
    "delete",
    "unlink_issues",
    {
      description: "Remove a link between two tickets. get_issue shows each link's id next to the linked issue.",
      inputSchema: z.strictObject({ link_id: z.string() }),
    },
    async ({ link_id }) => {
      await jira.sendJson(`/rest/api/2/issueLink/${link_id}`, undefined, "DELETE")
      return reply(`Removed link ${link_id}.`)
    },
  )
}
