// What the instance has: projects, their issue types and fields, users, and the token's own identity.
import * as z from "zod"

import { reply, type Tool } from "../shared/registry.ts"
import { allFields, briefField, jira, type Json, parseKey, person } from "./common.ts"

interface FieldMeta {
  id: string
  name: string
  required: boolean
  type: string
  allowed: string[]
}

function fieldMeta(id: string, meta: Json): FieldMeta {
  const schema = meta.schema ?? {}
  const type = schema.type === "array" ? `array of ${schema.items ?? "?"}` : (schema.type ?? "?")
  return {
    id,
    name: meta.name ?? id,
    required: meta.required === true,
    type: schema.custom ? `${type}, custom` : type,
    allowed: (meta.allowedValues ?? []).map(briefField),
  }
}

/** The fields a create screen takes, from the per-type endpoints of Jira 8.4+, or the one-shot expand before it. */
async function createMeta(project: string, type: string): Promise<FieldMeta[]> {
  const projectKey = project.toUpperCase()
  let typeId: string | undefined
  try {
    const types = (await jira.getJson(`/rest/api/2/issue/createmeta/${projectKey}/issuetypes`, { maxResults: 200 })) as Json
    const offered: Json[] = types.values ?? []
    typeId = offered.find((t) => (t.name ?? "").toLowerCase() === type.toLowerCase())?.id
    if (!typeId) throw new Error(`project ${projectKey} has no issue type '${type}'. It offers: ${offered.map((t) => t.name).join(", ") || "(none visible)"}.`)
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("HTTP 404"))) throw error
    const data = (await jira.getJson("/rest/api/2/issue/createmeta", {
      projectKeys: projectKey,
      issuetypeNames: type,
      expand: "projects.issuetypes.fields",
    })) as Json
    const fields: Json = data.projects?.[0]?.issuetypes?.[0]?.fields ?? {}
    if (!Object.keys(fields).length) throw new Error(`no create metadata for ${projectKey} / ${type}: check the project key and the issue type name.`)
    return Object.entries(fields).map(([id, meta]) => fieldMeta(id, meta as Json))
  }
  const data = (await jira.getJson(`/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${typeId}`, { maxResults: 200 })) as Json
  return (data.values ?? []).map((meta: Json) => fieldMeta(meta.fieldId, meta))
}

function describeFields(title: string, fields: FieldMeta[]): string {
  const line = (f: FieldMeta) => {
    const allowed = f.allowed.length ? `: ${f.allowed.slice(0, 20).join(", ")}${f.allowed.length > 20 ? ` (+${f.allowed.length - 20} more)` : ""}` : ""
    return `- ${f.id} — ${f.name} (${f.type})${allowed}`
  }
  const byName = (a: FieldMeta, b: FieldMeta) => a.name.localeCompare(b.name)
  const required = fields.filter((f) => f.required).sort(byName)
  const optional = fields.filter((f) => !f.required).sort(byName)
  return [
    `# ${title}`,
    "",
    "## Required",
    "",
    ...(required.length ? required.map(line) : ["_(none)_"]),
    "",
    "## Optional",
    "",
    ...(optional.length ? optional.map(line) : ["_(none)_"]),
  ].join("\n")
}

const userLine = (user: Json) =>
  `${user.name}  ${user.displayName ?? ""}${user.emailAddress ? `  <${user.emailAddress}>` : ""}${user.active === false ? "  (inactive)" : ""}`

export function registerDiscovery(tool: Tool) {
  tool(
    "read",
    "list_projects",
    {
      description: "List the projects the token can see: KEY  name  (type, lead). `query` keeps those whose key or name contains it.",
      inputSchema: z.strictObject({
        query: z.string().optional().describe("Part of a key or name"),
        limit: z.number().int().min(1).max(500).optional().describe("Most projects to list. Default 50"),
      }),
    },
    async ({ query, limit = 50 }) => {
      const all = (await jira.getJson("/rest/api/2/project", { expand: "lead,description" })) as Json[]
      const needle = query?.toLowerCase()
      const matched = (all ?? []).filter((p) => !needle || `${p.key} ${p.name}`.toLowerCase().includes(needle))
      if (!matched.length) return reply(query ? `No project matches '${query}'.` : "No projects visible to this token.")
      const lines = matched
        .slice(0, limit)
        .map(
          (p) => `${p.key}  ${p.name}  (${p.projectTypeKey ?? "?"}${person(p.lead) ? `, lead ${person(p.lead)}` : ""})  —  ${jira.baseUrl()}/projects/${p.key}`,
        )
      if (matched.length > limit) lines.push(`… ${matched.length - limit} more; raise \`limit\` or narrow \`query\``)
      return reply(lines.join("\n"))
    },
  )

  tool(
    "read",
    "get_project",
    {
      description: "Describe a project: lead, issue types, components, versions and the statuses each issue type can hold.",
      inputSchema: z.strictObject({ project: z.string().describe("Project key, such as PROJ") }),
    },
    async ({ project }) => {
      const projectKey = project.toUpperCase()
      const data = (await jira.getJson(`/rest/api/2/project/${projectKey}`)) as Json
      const statuses = (await jira.getJson(`/rest/api/2/project/${projectKey}/statuses`).catch(() => [])) as Json[]
      const lines = [`# ${data.key} — ${data.name}`, "", `- **Type:** ${data.projectTypeKey ?? "?"}`]
      if (person(data.lead)) lines.push(`- **Lead:** ${person(data.lead)}`)
      lines.push(`- **URL:** ${jira.baseUrl()}/projects/${data.key}`)
      if (data.description) lines.push(`- **Description:** ${String(data.description).replace(/\s+/g, " ").trim()}`)
      const types: Json[] = data.issueTypes ?? []
      lines.push(
        "",
        `## Issue types (${types.length})`,
        "",
        ...types.map((t) => `- ${t.name} (id ${t.id}${t.subtask ? ", subtask" : ""})${t.description ? ` — ${t.description}` : ""}`),
      )
      const components: Json[] = data.components ?? []
      lines.push(
        "",
        `## Components (${components.length})`,
        "",
        ...(components.length ? components.map((c) => `- ${c.name}${person(c.lead) ? ` — lead ${person(c.lead)}` : ""}`) : ["_(none)_"]),
      )
      const versions: Json[] = data.versions ?? []
      const versionLine = (v: Json) =>
        `- ${v.name} (id ${v.id}; ${v.archived ? "archived" : v.released ? `released ${v.releaseDate ?? ""}`.trim() : `unreleased${v.releaseDate ? `, due ${v.releaseDate}` : ""}`})`
      lines.push("", `## Versions (${versions.length})`, "", ...(versions.length ? versions.map(versionLine) : ["_(none)_"]))
      if (statuses.length) {
        lines.push("", "## Statuses by issue type", "", ...statuses.map((s) => `- ${s.name}: ${(s.statuses ?? []).map((st: Json) => st.name).join(", ")}`))
      }
      return reply(`${lines.join("\n")}\n`)
    },
  )

  tool(
    "read",
    "get_issue_fields",
    {
      description:
        "The fields a ticket takes, with ids, types and allowed values: for creating one in a project with `project` and `type`, or for editing an existing one with `key`. " +
        "The required list is what create_issue must send.",
      inputSchema: z.strictObject({
        project: z.string().optional().describe("Project key, with `type`"),
        type: z.string().optional().describe("Issue type name, with `project`"),
        key: z.string().optional().describe("An existing ticket, for its edit screen instead"),
      }),
    },
    async ({ project, type, key: target }) => {
      if (target) {
        const issueKey = parseKey(target)
        const data = (await jira.getJson(`/rest/api/2/issue/${issueKey}/editmeta`)) as Json
        return reply(
          describeFields(
            `Fields editable on ${issueKey}`,
            Object.entries(data.fields ?? {}).map(([id, meta]) => fieldMeta(id, meta as Json)),
          ),
        )
      }
      if (!project || !type) throw new Error("Pass `project` and `type` for a create screen, or `key` for an edit screen.")
      return reply(describeFields(`Fields to create a ${type} in ${project.toUpperCase()}`, await createMeta(project, type)))
    },
  )

  tool(
    "read",
    "list_fields",
    {
      description: "List the fields the instance knows, system and custom, with their ids: id  Name  (type). `query` keeps those whose id or name contains it.",
      inputSchema: z.strictObject({ query: z.string().optional().describe('Part of a name or id, such as "epic" or "customfield_100"') }),
    },
    async ({ query }) => {
      const needle = query?.toLowerCase()
      const fields = (await allFields())
        .filter((f) => !needle || `${f.id} ${f.name}`.toLowerCase().includes(needle))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      if (!fields.length) return reply(query ? `No field matches '${query}'.` : "No fields returned.")
      const typeOf = (f: Json) => (f.schema?.type === "array" ? `array of ${f.schema.items ?? "?"}` : (f.schema?.type ?? "?")) + (f.custom ? ", custom" : "")
      const shown = fields.slice(0, 150)
      const lines = shown.map((f) => `${f.id}  ${f.name}  (${typeOf(f)})`)
      if (fields.length > shown.length) lines.push(`… ${fields.length - shown.length} more; narrow \`query\``)
      return reply(lines.join("\n"))
    },
  )

  tool(
    "read",
    "search_users",
    {
      description:
        "Find users by part of a username, display name or email: username  Display Name  <email>. With `assignable_to`, only those who may be assigned that ticket or a ticket in that project. " +
        "Usernames are what assignee, reporter and watch_issue take.",
      inputSchema: z.strictObject({
        query: z.string().describe('Part of a username, name or email; "." matches everyone assignable'),
        assignable_to: z.string().optional().describe("A ticket key or a project key"),
        limit: z.number().int().min(1).max(1000).optional().describe("Default 20"),
      }),
    },
    async ({ query, assignable_to, limit = 20 }) => {
      let users: Json[]
      if (assignable_to && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(assignable_to.trim())) {
        users = (await jira.getJson("/rest/api/2/user/assignable/search", { issueKey: parseKey(assignable_to), username: query, maxResults: limit })) as Json[]
      } else if (assignable_to) {
        users = (await jira.getJson("/rest/api/2/user/assignable/search", {
          project: assignable_to.toUpperCase(),
          username: query,
          maxResults: limit,
        })) as Json[]
      } else {
        users = (await jira.getJson("/rest/api/2/user/search", { username: query, maxResults: limit })) as Json[]
      }
      if (!users?.length) return reply(`No user matches '${query}'${assignable_to ? ` assignable to ${assignable_to}` : ""}.`)
      return reply(users.map(userLine).join("\n"))
    },
  )

  tool(
    "read",
    "whoami",
    { description: "Who the token is: username, display name, email, time zone. A cheap check that the URL and token work.", inputSchema: z.strictObject({}) },
    async () => {
      const me = (await jira.getJson("/rest/api/2/myself")) as Json
      return reply(`${userLine(me)}${me.timeZone ? `  — time zone ${me.timeZone}` : ""}  — ${jira.baseUrl()}`)
    },
  )

  tool(
    "read",
    "jira_get",
    {
      description:
        "Read any Jira REST path no other tool covers, as JSON: GET only, on the configured host, under /rest/. Examples: /rest/api/2/serverInfo, " +
        "/rest/api/2/filter/favourite, /rest/api/2/issue/PROJ-1/votes. Prefer the specific tool when one exists.",
      inputSchema: z.strictObject({
        path: z.string().describe("A path starting with /rest/"),
        query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
      }),
    },
    async ({ path, query }) => reply(await jira.rawGet(path, query)),
  )
}
