// Who may see and edit a page, and who the people are: restrictions and user search.
import * as z from "zod"

import { reply, type Tool } from "../shared/registry.ts"
import { quoted } from "../shared/text.ts"
import { confluence, type Json, pageRef, pageUrl, resolvePageId, spaceRef } from "./common.ts"

const OPERATIONS = ["read", "update"] as const
type Operation = (typeof OPERATIONS)[number]
interface Restriction {
  users: string[]
  groups: string[]
}

const EXPAND = OPERATIONS.flatMap((op) => [`${op}.restrictions.user`, `${op}.restrictions.group`]).join(",")

/** The current restrictions, by operation, as usernames and group names. */
async function restrictionsOf(pageId: string): Promise<Record<Operation, Restriction>> {
  const data = (await confluence.getJson(`/rest/api/content/${pageId}/restriction/byOperation`, { expand: EXPAND })) as Json
  const current = {} as Record<Operation, Restriction>
  for (const op of OPERATIONS) {
    const restrictions = data[op]?.restrictions ?? {}
    current[op] = {
      users: (restrictions.user?.results ?? []).map((u: Json) => u.username ?? u.name ?? "?"),
      groups: (restrictions.group?.results ?? []).map((g: Json) => g.name ?? "?"),
    }
  }
  return current
}

const describe = (op: Operation, r: Restriction) => {
  if (!r.users.length && !r.groups.length) return `- ${op}: unrestricted (everyone the space lets ${op === "read" ? "view" : "edit"})`
  const parts = [r.users.length ? `users ${r.users.join(", ")}` : "", r.groups.length ? `groups ${r.groups.join(", ")}` : ""].filter(Boolean)
  return `- ${op}: only ${parts.join("; ")}`
}

const who = z.strictObject({
  users: z.array(z.string()).optional().describe("Usernames; search_users finds them"),
  groups: z.array(z.string()).optional().describe("Group names"),
})

export function registerAccess(tool: Tool) {
  tool(
    "read",
    "get_restrictions",
    {
      description:
        "Who may view and who may edit a page: the users and groups each operation is restricted to, or unrestricted when the space permissions alone apply.",
      inputSchema: z.strictObject({ page: pageRef, space: spaceRef }),
    },
    async ({ page, space }) => {
      const pageId = await resolvePageId(page, space)
      const info = (await confluence.getJson(`/rest/api/content/${pageId}`)) as Json
      const current = await restrictionsOf(pageId)
      return reply([`Restrictions on "${info.title}" (${pageId}) — ${pageUrl(info)}`, ...OPERATIONS.map((op) => describe(op, current[op]))].join("\n"))
    },
  )

  tool(
    "write",
    "set_restrictions",
    {
      description:
        "Restrict who may view (`read`) or edit (`update`) a page. Each operation passed is replaced by exactly the users and groups given, empty lists lifting it; an operation " +
        "left out keeps its current restriction. The token's user is kept on an edit restriction so the page stays editable from here. Reports the restrictions that then apply.",
      inputSchema: z.strictObject({
        page: pageRef,
        space: spaceRef,
        read: who.optional().describe("Who may view the page"),
        update: who.optional().describe("Who may edit the page"),
      }),
      idempotent: true,
    },
    async ({ page, space, read, update }) => {
      if (!read && !update) throw new Error("Nothing to change: pass `read` or `update`.")
      const pageId = await resolvePageId(page, space)
      const info = (await confluence.getJson(`/rest/api/content/${pageId}`)) as Json
      const next = await restrictionsOf(pageId)
      const notes: string[] = []
      for (const [op, wanted] of [
        ["read", read],
        ["update", update],
      ] as const) {
        if (!wanted) continue
        next[op] = { users: [...new Set(wanted.users ?? [])], groups: [...new Set(wanted.groups ?? [])] }
      }
      if (update && (next.update.users.length || next.update.groups.length)) {
        const me = (await confluence.getJson("/rest/api/user/current")) as Json
        if (me.username && !next.update.users.includes(me.username)) {
          next.update.users.push(me.username)
          notes.push(`${me.username} was added to the edit restriction so this token keeps access.`)
        }
      }
      await confluence.sendJson(
        `/rest/api/content/${pageId}/restriction`,
        OPERATIONS.map((op) => ({
          operation: op,
          restrictions: {
            user: next[op].users.map((username) => ({ type: "known", username })),
            group: next[op].groups.map((name) => ({ type: "group", name })),
          },
        })),
        "PUT",
      )
      const after = await restrictionsOf(pageId)
      return reply([`Restrictions on "${info.title}" (${pageId}) — ${pageUrl(info)}`, ...OPERATIONS.map((op) => describe(op, after[op])), ...notes].join("\n"))
    },
  )

  tool(
    "read",
    "search_users",
    {
      description:
        "Find Confluence users by part of a name, or by exact username: one per line, username  Display name  (key). Confluence usernames go into set_restrictions and may differ from Jira's.",
      inputSchema: z.strictObject({
        query: z.string().describe("Part of a display name, or a username"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 10"),
      }),
    },
    async ({ query, limit = 10 }) => {
      const needle = query.trim()
      if (!needle) throw new Error("`query` is empty.")
      const data = (await confluence.getJson("/rest/api/search", { cql: `type=user AND user.fullname ~ ${quoted(needle)}`, limit })) as Json
      const users: Json[] = (data.results ?? []).map((hit: Json) => hit.user ?? hit).filter((u: Json) => u.username || u.displayName)
      if (!users.length && /^[\w.@-]+$/.test(needle)) {
        try {
          users.push((await confluence.getJson("/rest/api/user", { username: needle })) as Json)
        } catch (error) {
          if (!(error instanceof Error && error.message.startsWith("HTTP 404"))) throw error
        }
      }
      if (!users.length) return reply(`No user matches '${needle}'.`)
      return reply(users.map((u) => `${u.username ?? "?"}  ${u.displayName ?? ""}${u.userKey ? `  (key ${u.userKey})` : ""}`).join("\n"))
    },
  )
}
