// Around a page: attachments, comments, labels, the token's identity and the REST passthrough.
import { randomUUID } from "node:crypto"

import * as z from "zod"

import { readUpload } from "../shared/files.ts"
import { reply, type Tool } from "../shared/registry.ts"
import { formatSize } from "../shared/text.ts"
import {
  body,
  bodyFormat,
  confluence,
  footer,
  type Json,
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

function commentLines(comment: Json): string[] {
  const extensions = comment.extensions ?? {}
  const tags = [`comment ${comment.id}`]
  const parent = (comment.ancestors ?? []).filter((a: Json) => a.type === "comment").at(-1)
  if (parent) tags.push(`reply to ${parent.id}`)
  if (extensions.location === "inline") tags.push(`inline on "${extensions.inlineProperties?.originalSelection ?? "…"}"`)
  if (extensions.resolution?.status) tags.push(extensions.resolution.status)
  const author = person(comment.version?.by) ?? person(comment.history?.createdBy) ?? "?"
  return [
    `### ${author} — ${when(comment.version?.when ?? comment.history?.createdDate)} (${tags.join(", ")})`,
    "",
    htmlToMarkdown(body(comment, "view")).trim() || "_(empty)_",
    "",
  ]
}

const withComment = (url: string, id: string) => `${url}${url.includes("?") ? "&" : "?"}focusedCommentId=${id}`

/** The text of a storage body, roughly as a reader sees it: tags dropped, the common entities decoded. */
const textOf = (storage: string) =>
  storage
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")

function countMatches(haystack: string, needle: string): number {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++
  return count
}

/** The inline-comment extensions for `anchor`: the text, how often it occurs on the page and which occurrence is meant. */
async function inlineAnchor(pageId: string, anchor: string, occurrence: number) {
  const page = (await confluence.getJson(`/rest/api/content/${pageId}`, { expand: "body.storage" })) as Json
  const matches = countMatches(textOf(body(page, "storage")), anchor)
  if (!matches)
    throw new Error(`'${anchor}' is not on the page as plain text, so there is nothing to anchor the comment to. Pass text exactly as the page shows it.`)
  if (occurrence > matches) throw new Error(`'${anchor}' occurs ${matches} time(s) on the page, so occurrence ${occurrence} does not exist.`)
  return {
    matches,
    extensions: {
      location: "inline",
      inlineProperties: { originalSelection: anchor, markerRef: randomUUID(), numMatches: matches, matchIndex: occurrence - 1 },
    },
  }
}

export function registerExtras(tool: Tool) {
  tool(
    "read",
    "get_attachment",
    {
      description: "Read an attachment by the URL get_page lists: an image comes back as an image, text as text, any other type as its name and size.",
      inputSchema: z.strictObject({ url: z.string().describe("The download URL, on the Confluence host; a relative one is resolved against it") }),
    },
    ({ url }) => confluence.attachment(url),
  )

  tool(
    "read",
    "get_comments",
    {
      description:
        "The comments on a page, footer and inline, replies included, each as Markdown under a line naming the author, time, id, what it replies to and the text it is anchored on.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        location: z.enum(["footer", "inline", "all"]).optional().describe("Default all, which includes resolved inline comments"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        start,
      }),
    },
    async ({ page, space, location = "all", limit = 50, start: from = 0 }) => {
      const pageId = await resolvePageId(page, space)
      const where = location === "all" ? ["footer", "inline", "resolved"] : [location]
      const data = (await confluence.getJson(`/rest/api/content/${pageId}/child/comment`, {
        expand: "body.view,version,ancestors,extensions.location,extensions.inlineProperties,extensions.resolution",
        depth: "all",
        location: where,
        start: from,
        limit,
      })) as Json
      const comments: Json[] = data.results ?? []
      if (!comments.length) return reply(`Page ${pageId} has no ${location === "all" ? "" : `${location} `}comments.`)
      return reply([...comments.flatMap(commentLines), footer(data, from, comments.length)].join("\n"))
    },
  )

  tool(
    "read",
    "whoami",
    { description: "Who the token is: username and display name. A cheap check that the URL and token work.", inputSchema: z.strictObject({}) },
    async () => {
      const me = (await confluence.getJson("/rest/api/user/current")) as Json
      return reply(`${me.username ?? "?"}  ${me.displayName ?? ""}${me.userKey ? `  (key ${me.userKey})` : ""}  — ${confluence.baseUrl()}`)
    },
  )

  tool(
    "read",
    "confluence_get",
    {
      description:
        "Read any Confluence REST path no other tool covers, as JSON: GET only, on the configured host, under /rest/. Examples: /rest/api/content/123/restriction/byOperation, " +
        "/rest/api/space/ENG, /rest/api/content/123/child/attachment. Prefer the specific tool when one exists.",
      inputSchema: z.strictObject({
        path: z.string().describe("A path starting with /rest/"),
        query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
      }),
    },
    async ({ path, query }) => reply(await confluence.rawGet(path, query)),
  )

  tool(
    "write",
    "add_comment",
    {
      description:
        "Add a footer comment to a page, an inline comment anchored to text on it with `anchor`, or a reply to a comment. Everyone on the page sees it.",
      inputSchema: z.strictObject({
        page: pageRef.optional().describe("The page, for a new top-level comment"),
        space: spaceRef,
        reply_to: z.string().optional().describe("A comment id to reply to instead; get_comments shows them"),
        body: z.string().regex(/\S/, "is empty: nothing to post").describe(`The comment, ${STORAGE}`),
        format: bodyFormat,
        anchor: z.string().regex(/\S/, "is empty").optional().describe("Text on the page, exactly as it reads, to anchor the comment to as an inline comment"),
        occurrence: z.number().int().min(1).optional().describe("With `anchor`, which occurrence when the text appears more than once. Default 1, the first"),
      }),
    },
    async ({ page, space, reply_to, body: content, format, anchor, occurrence = 1 }) => {
      if ((page === undefined) === (reply_to === undefined)) throw new Error("Pass exactly one of `page` or `reply_to`.")
      if (anchor !== undefined && reply_to !== undefined) throw new Error("A reply sits under its comment: `anchor` goes with `page`, not `reply_to`.")
      let pageId: string
      if (reply_to !== undefined) {
        const parent = (await confluence.getJson(`/rest/api/content/${reply_to}`, { expand: "container" })) as Json
        if (parent.type !== "comment" || !parent.container?.id) throw new Error(`${reply_to} is not a comment on a page, so it cannot be replied to.`)
        pageId = String(parent.container.id)
      } else {
        pageId = await resolvePageId(page ?? "", space)
      }
      const inline = anchor === undefined ? undefined : await inlineAnchor(pageId, anchor, occurrence)
      const made = (await confluence.sendJson(
        "/rest/api/content",
        {
          type: "comment",
          container: { id: pageId, type: "page" },
          ...(reply_to !== undefined && { ancestors: [{ id: reply_to }] }),
          body: { storage: { value: await toStorage(content, format), representation: "storage" } },
          ...(inline && { extensions: inline.extensions }),
        },
        "POST",
      )) as Json | null
      const id = String(made?.id ?? "?")
      const pageInfo = (await confluence.getJson(`/rest/api/content/${pageId}`)) as Json
      const what =
        reply_to !== undefined
          ? `Replied to comment ${reply_to}`
          : inline
            ? `Commented inline at "${anchor}"${inline.matches > 1 ? ` (occurrence ${occurrence} of ${inline.matches})` : ""}`
            : "Commented"
      return reply(`${what} on "${pageInfo.title}" (comment ${id}) — ${withComment(pageUrl(pageInfo), id)}`)
    },
  )

  tool(
    "write",
    "set_labels",
    {
      description: "Add labels to a page and remove labels from it; reports the labels it then has.",
      inputSchema: z.strictObject({ page: pageRef, space: spaceRef, add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }),
      idempotent: true,
    },
    async ({ page, space, add, remove }) => {
      if (!add?.length && !remove?.length) throw new Error("Nothing to change: pass `add` or `remove`.")
      const pageId = await resolvePageId(page, space)
      if (add?.length)
        await confluence.sendJson(
          `/rest/api/content/${pageId}/label`,
          add.map((name) => ({ prefix: "global", name })),
          "POST",
        )
      for (const name of remove ?? []) await confluence.sendJson(`/rest/api/content/${pageId}/label`, undefined, "DELETE", { name })
      const now = (await confluence.getJson(`/rest/api/content/${pageId}/label`)) as Json
      const names: string[] = (now.results ?? []).map((l: Json) => l.name)
      const changes = [...(add ?? []).map((l) => `+${l}`), ...(remove ?? []).map((l) => `-${l}`)].join(", ")
      return reply(`Labels on page ${pageId}: ${changes}. Now: ${names.join(", ") || "(none)"}`)
    },
  )

  tool(
    "write",
    "add_attachment",
    {
      description:
        "Upload a file from this machine to a page. A file with the same name already on the page gets a new version unless `replace` is false. Pass the absolute path.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        path: z.string().describe("Absolute path of the file to upload"),
        comment: z.string().optional().describe("A note on this version of the file"),
        replace: z.boolean().optional().describe("Default true: replace an attachment of the same name"),
      }),
    },
    async ({ page, space, path, comment, replace = true }) => {
      const pageId = await resolvePageId(page, space)
      const file = await readUpload(path, "Confluence")
      const existing = (await confluence.getJson(`/rest/api/content/${pageId}/child/attachment`, { filename: file.name })) as Json
      const previous: Json | undefined = existing.results?.[0]
      const fields = { ...(comment && { comment }), minorEdit: "true" }
      const result = (await (previous && replace
        ? confluence.upload(`/rest/api/content/${pageId}/child/attachment/${previous.id}/data`, file, fields)
        : confluence.upload(`/rest/api/content/${pageId}/child/attachment`, file, fields))) as Json | null
      const made: Json = result?.results?.[0] ?? result ?? {}
      const link: string = made._links?.download ?? ""
      const download = link && !link.startsWith("http") ? `${confluence.baseUrl()}${link}` : link
      return reply(
        `${previous && replace ? "Replaced" : "Uploaded"} ${made.title ?? file.name} (${made.metadata?.mediaType ?? file.mimeType}, ${formatSize(made.extensions?.fileSize ?? file.bytes.length)}, id ${made.id ?? "?"}) on page ${pageId}${download ? ` — ${download}` : ""}`,
      )
    },
  )

  tool(
    "delete",
    "delete_comment",
    { description: "Delete a comment from a page. get_comments shows the ids.", inputSchema: z.strictObject({ comment_id: z.string() }) },
    async ({ comment_id }) => {
      await confluence.sendJson(`/rest/api/content/${comment_id}`, undefined, "DELETE")
      return reply(`Deleted comment ${comment_id}.`)
    },
  )

  tool(
    "delete",
    "delete_attachment",
    {
      description: "Delete an attachment from a page, into the page's trash. get_page shows the ids.",
      inputSchema: z.strictObject({ attachment_id: z.string() }),
    },
    async ({ attachment_id }) => {
      await confluence.sendJson(`/rest/api/content/${attachment_id}`, undefined, "DELETE")
      return reply(`Deleted attachment ${attachment_id}.`)
    },
  )
}
