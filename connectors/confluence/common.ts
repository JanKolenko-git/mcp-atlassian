// Shared by the Confluence tool modules: the client, page resolution, body conversion and the
// header every page read starts with.
import * as z from "zod"

import { connect } from "../shared/http.ts"
import { formatSize, pageFooter } from "../shared/text.ts"
import { markdownToWiki } from "../shared/wiki.ts"

export const confluence = connect("Confluence")

// The REST payloads are read loosely: any field may be missing or null.
export type Json = Record<string, any>

/** A page id from a numeric id, any URL shape Confluence hands out, or a title. */
export async function resolvePageId(page: string, space?: string): Promise<string> {
  const target = page.trim()
  if (/^\d+$/.test(target)) return target
  const pageId = /[?&]pageId=(\d+)/.exec(target)?.[1] ?? /\/pages\/(\d+)(?:[/?#]|$)/.exec(target)?.[1]
  if (pageId) return pageId
  const display = /\/display\/([^/?#]+)\/([^/?#]+)/.exec(target)
  if (display?.[1] && display[2]) {
    return pageByTitle(decodeURIComponent(display[2].replaceAll("+", " ")), decodeURIComponent(display[1]))
  }
  if (target.includes("://")) throw new Error(`could not work out a page from '${page}'. Pass a page URL, a numeric page id or a title.`)
  return pageByTitle(target, space)
}

async function pageByTitle(title: string, space?: string): Promise<string> {
  const data = (await confluence.getJson("/rest/api/content", { type: "page", title, spaceKey: space, limit: 5, expand: "space" })) as Json
  const results: Json[] = data.results ?? []
  if (!results.length) throw new Error(`no page titled '${title}'${space ? ` in space ${space}` : ""}. search_pages finds pages by part of a title.`)
  if (results.length === 1) return String(results[0]?.id)
  const listed = results.map((r) => `  ${r.id}  [${r.space?.key ?? "?"}]  ${r.title}`).join("\n")
  throw new Error(`more than one page is titled '${title}':\n${listed}\nPass \`space\` or the page id.`)
}

export function pageUrl(page: Json): string {
  const webui = page._links?.webui
  return webui ? `${confluence.baseUrl()}${webui}` : `${confluence.baseUrl()}/pages/viewpage.action?pageId=${page.id}`
}

export const body = (page: Json, format: string): string => page.body?.[format]?.value ?? ""
export const person = (value: Json | null | undefined) => value?.displayName || value?.username || null
export const when = (value: string | null | undefined) => (value ?? "").slice(0, 16).replace("T", " ")
export const pageLine = (page: Json) => `${page.id}  [${page.space?.key ?? "?"}]  ${page.title}  —  ${pageUrl(page)}`

/** The footer of a Confluence list, which carries `totalSize` on a search and a `next` link elsewhere. */
export const footer = (data: Json, from: number, shown: number) =>
  pageFooter(from, shown, typeof data.totalSize === "number" ? data.totalSize : undefined, data._links?.next ? true : undefined)

export const pageRef = z.string().describe("A page URL (full, viewpage.action or display), a numeric page id, or an exact title")
export const spaceRef = z.string().optional().describe("Space key to narrow a title, such as ENG")
export const start = z.number().int().min(0).optional().describe("Row to start at, from the previous footer. Default 0")
export const bodyFormat = z
  .enum(["storage", "wiki", "markdown"])
  .optional()
  .describe(
    "How the body is written: storage (default) is storage-format XHTML sent as is; wiki is Confluence wiki markup; markdown is converted. Confluence itself renders wiki and markdown to storage",
  )
export const STORAGE = "in storage-format XHTML (<h2>, <p>, <ul>, <table>), or wiki markup or Markdown with `format`"

/**
 * The storage body Confluence stores: as given, or rendered by Confluence's own converter from
 * wiki markup, Markdown having gone through the shared wiki converter first.
 */
export async function toStorage(content: string, format?: "storage" | "wiki" | "markdown"): Promise<string> {
  if (!format || format === "storage") return content
  const wiki = format === "markdown" ? markdownToWiki(content) : content
  const result = (await confluence.sendJson("/rest/api/contentbody/convert/storage", { value: wiki, representation: "wiki" }, "POST")) as Json | null
  if (typeof result?.value !== "string") throw new Error("Confluence returned no storage body from the wiki conversion.")
  return result.value
}

/** A page as a write needs it: title, space, version and the storage body. */
export async function currentPage(pageId: string): Promise<Json> {
  const page = (await confluence.getJson(`/rest/api/content/${pageId}`, { expand: "body.storage,version,space,ancestors" })) as Json
  if (typeof page.version?.number !== "number") throw new Error("the API response carried no version number, so a safe update is not possible.")
  return page
}

export function header(page: Json, pageId: string, note?: string): string[] {
  const lines = [`# ${page.title ?? "(untitled)"}`, "", `- **Page ID:** ${pageId}`]
  lines.push(`- **Space:** ${page.space?.key ?? "?"}${page.space?.name ? ` — ${page.space.name}` : ""}`)
  const ancestors: Json[] = page.ancestors ?? []
  if (ancestors.length) lines.push(`- **Breadcrumb:** ${ancestors.map((a) => a.title ?? "?").join(" › ")}`)
  const version = page.version
  if (version && Object.keys(version).length) {
    lines.push(`- **Version:** ${version.number ?? "?"} — last updated ${(version.when ?? "").slice(0, 10)} by ${version.by?.displayName || "?"}`)
  }
  const labels: Json[] = page.metadata?.labels?.results ?? []
  if (labels.length) lines.push(`- **Labels:** ${labels.map((l) => l.name ?? "").join(", ")}`)
  lines.push(`- **URL:** ${pageUrl(page)}`)
  const attachments = page.children?.attachment ?? {}
  const listed: Json[] = attachments.results ?? []
  if (listed.length) {
    lines.push(`- **Attachments (${listed.length}):**`)
    for (const item of listed) {
      const link: string = item._links?.download ?? ""
      const download = link && !link.startsWith("http") ? `${confluence.baseUrl()}${link}` : link
      lines.push(`  - ${item.title} (${item.metadata?.mediaType ?? "?"}, ${formatSize(item.extensions?.fileSize || 0)}, id ${item.id ?? "?"}) — ${download}`)
    }
    if (attachments._links?.next) lines.push(`  - … more attachments than the ${listed.length} listed`)
  }
  if (note) lines.push(`- **Note:** ${note}`)
  return lines
}
