// Page templates: the ones a space or the site offers, what one contains, and a page made from one
// with its variables filled in.
import * as z from "zod"

import { reply, type Tool } from "../shared/registry.ts"
import { confluence, footer, type Json, pageRef, pageUrl, resolvePageId, start } from "./common.ts"
import { htmlToMarkdown } from "./markdown.ts"

const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

// A template variable: <at:var at:name="x" /> or <at:var at:name="x" at:rawxhtml="true"></at:var>; the declarations block lists them.
const VAR = /<at:var\b([^>]*?)(?:\/>|>[\s\S]*?<\/at:var>)/g
const DECLARATIONS = /<at:declarations>[\s\S]*?<\/at:declarations>\s*/g
const nameOf = (attributes: string) => /at:name="([^"]*)"/.exec(attributes)?.[1] ?? ""

export const variablesOf = (storage: string): string[] => [...new Set([...storage.matchAll(VAR)].map((m) => nameOf(m[1] ?? "")).filter(Boolean))]

/** The template body with each variable replaced by its value, and the names of those left empty. */
export function fill(storage: string, values: Record<string, string>): { body: string; empty: string[] } {
  const empty = new Set<string>()
  const body = storage.replaceAll(DECLARATIONS, "").replaceAll(VAR, (_, attributes: string) => {
    const name = nameOf(attributes)
    const value = values[name]
    if (value === undefined) {
      if (name) empty.add(name)
      return ""
    }
    return /at:rawxhtml="true"/.test(attributes) ? value : escapeXml(value)
  })
  return { body, empty: [...empty] }
}

async function template(id: string): Promise<Json> {
  return (await confluence.getJson(`/rest/api/template/${encodeURIComponent(id)}`, { expand: "body" })) as Json
}

export function registerTemplates(tool: Tool) {
  tool(
    "read",
    "list_templates",
    {
      description:
        "List page templates: those of a space with `space`, else the site's global ones. One per line: id  name  — description. Blueprints are listed with type blueprint; a page is created only from a page template.",
      inputSchema: z.strictObject({
        space: z.string().optional().describe("Space key, such as ENG; omitted lists global templates"),
        type: z.enum(["page", "blueprint"]).optional().describe("Default page"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        start,
      }),
    },
    async ({ space, type = "page", limit = 50, start: from = 0 }) => {
      const data = (await confluence.getJson(`/rest/api/template/${type}`, { spaceKey: space, start: from, limit })) as Json
      const templates: Json[] = data.results ?? []
      if (!templates.length) return reply(`No ${type} templates ${space ? `in space ${space}` : "defined globally"}.`)
      const lines = templates.map((t) => `${t.templateId ?? "?"}  ${t.name ?? "(unnamed)"}${t.description ? `  — ${t.description}` : ""}`)
      return reply([...lines, footer(data, from, templates.length)].join("\n"))
    },
  )

  tool(
    "read",
    "get_template",
    {
      description:
        "Read a page template: its name, description and the variables it declares, then the body as Markdown, or as storage XHTML with format storage. The variables are what create_page_from_template fills.",
      inputSchema: z.strictObject({
        template_id: z.string().describe("The template id list_templates shows"),
        format: z.enum(["markdown", "storage"]).optional().describe("Default markdown"),
      }),
    },
    async ({ template_id, format = "markdown" }) => {
      const found = await template(template_id)
      const storage: string = found.body?.storage?.value ?? ""
      const variables = variablesOf(storage)
      const lines = [
        `# ${found.name ?? "(unnamed)"}`,
        "",
        `- **Template ID:** ${found.templateId ?? template_id}`,
        `- **Type:** ${found.templateType ?? "?"}${found.space?.key ? ` in space ${found.space.key}` : " (global)"}`,
        ...(found.description ? [`- **Description:** ${found.description}`] : []),
        `- **Variables:** ${variables.join(", ") || "(none)"}`,
        "",
        "---",
        "",
        format === "storage" ? storage : htmlToMarkdown(fill(storage, Object.fromEntries(variables.map((v) => [v, `{${v}}`]))).body).trim(),
      ]
      return reply(lines.join("\n"))
    },
  )

  tool(
    "write",
    "create_page_from_template",
    {
      description:
        "Create a page from a page template, with its variables filled from `variables`; one left out is left empty and named in the reply. Returns the page's id and link.",
      inputSchema: z.strictObject({
        template_id: z.string().describe("The template id list_templates shows"),
        space: z.string().describe("Space key to create the page in"),
        title: z.string().describe("The title; unique within the space"),
        parent: pageRef.optional().describe("The page to create it under"),
        variables: z.record(z.string(), z.string()).optional().describe("Values by variable name, as get_template lists them"),
        labels: z.array(z.string()).optional(),
      }),
    },
    async ({ template_id, space, title, parent, variables, labels }) => {
      const found = await template(template_id)
      const storage: string = found.body?.storage?.value ?? ""
      if (!storage.trim()) throw new Error(`template ${template_id} has no body.`)
      const { body, empty } = fill(storage, variables ?? {})
      const parentId = parent === undefined ? undefined : await resolvePageId(parent, space)
      const made = (await confluence.sendJson(
        "/rest/api/content",
        {
          type: "page",
          title,
          space: { key: space },
          ...(parentId && { ancestors: [{ id: parentId }] }),
          body: { storage: { value: body, representation: "storage" } },
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
      const notes = [labels?.length ? ` with labels ${labels.join(", ")}` : "", empty.length ? `. Left empty: ${empty.join(", ")}` : ""].join("")
      return reply(
        `Created "${made.title ?? title}" (${made.id}, v${made.version?.number ?? 1}) in ${space} from template ${found.name ?? template_id}${notes} — ${pageUrl(made)}`,
      )
    },
  )
}
