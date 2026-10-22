// Planning: boards, sprints, the backlog and epics through the Agile API, and versions through REST v2.
import * as z from "zod"

import { reply, type Tool } from "../shared/registry.ts"
import { pageFooter } from "../shared/text.ts"
import { day, issueLine, jira, jiraDate, type Json, key, parseKey, start } from "./common.ts"

const AGILE = "/rest/agile/1.0"
const board = z.number().int().describe("Board id, from list_boards")
const sprintId = z.number().int().describe("Sprint id, from list_sprints")
const limit = z.number().int().min(1).max(100).optional().describe("Most rows to return. Default 50")

const sprintLine = (s: Json) =>
  `${s.id}  ${s.name}  [${s.state ?? "?"}]${s.startDate || s.endDate ? `  ${day(s.startDate) ?? "?"} → ${day(s.endDate) ?? "?"}` : ""}${s.goal ? `  — ${s.goal}` : ""}`

/** The footer of an Agile list, which says `isLast` and sometimes a total. */
const agileFooter = (from: number, shown: number, data: Json) =>
  pageFooter(from, shown, typeof data.total === "number" ? data.total : undefined, data.isLast === false)

export function registerAgile(tool: Tool) {
  tool(
    "read",
    "list_boards",
    {
      description: "List boards: id  name  (scrum or kanban)  project. Filter by project, type or part of the name.",
      inputSchema: z.strictObject({
        project: z.string().optional().describe("Project key"),
        type: z.enum(["scrum", "kanban"]).optional(),
        name: z.string().optional().describe("Part of the board name"),
        start,
        limit,
      }),
    },
    async ({ project, type, name, start: from = 0, limit: max = 50 }) => {
      const data = (await jira.getJson(`${AGILE}/board`, { projectKeyOrId: project?.toUpperCase(), type, name, startAt: from, maxResults: max })) as Json
      const boards: Json[] = data.values ?? []
      if (!boards.length) return reply("No boards matched.")
      const lines = boards.map((b) => `${b.id}  ${b.name}  (${b.type ?? "?"})${b.location?.projectKey ? `  ${b.location.projectKey}` : ""}`)
      return reply([...lines, agileFooter(from, boards.length, data)].join("\n"))
    },
  )

  tool(
    "read",
    "list_sprints",
    {
      description: "List the sprints of a board: id  name  [state]  start → end  — goal.",
      inputSchema: z.strictObject({
        board,
        state: z
          .array(z.enum(["future", "active", "closed"]))
          .optional()
          .describe("Only these states. Default: all"),
        start,
        limit,
      }),
    },
    async ({ board: id, state, start: from = 0, limit: max = 50 }) => {
      const data = (await jira.getJson(`${AGILE}/board/${id}/sprint`, { state: state?.join(","), startAt: from, maxResults: max })) as Json
      const sprints: Json[] = data.values ?? []
      if (!sprints.length) return reply(`Board ${id}: no sprints${state ? ` in state ${state.join(", ")}` : ""}.`)
      return reply([...sprints.map(sprintLine), agileFooter(from, sprints.length, data)].join("\n"))
    },
  )

  tool(
    "read",
    "get_sprint_issues",
    {
      description:
        "The issues in a sprint, or in the backlog of a board: exactly one of `sprint` or `backlog_of_board`. A sprint is described first, then one line per issue.",
      inputSchema: z.strictObject({
        sprint: sprintId.optional(),
        backlog_of_board: board.optional().describe("A board id, for its backlog instead of a sprint"),
        jql: z.string().optional().describe("Narrow the issues, such as assignee = currentUser()"),
        fields: z.array(z.string()).optional().describe("Fields to show under each line, by id"),
        start,
        limit,
      }),
    },
    async ({ sprint, backlog_of_board, jql, fields, start: from = 0, limit: max = 50 }) => {
      if ((sprint === undefined) === (backlog_of_board === undefined)) throw new Error("Pass exactly one of `sprint` or `backlog_of_board`.")
      const query = { jql, startAt: from, maxResults: max, fields: ["summary", "status", ...(fields ?? [])].join(",") }
      const head: string[] = []
      let data: Json
      if (sprint !== undefined) {
        head.push(sprintLine((await jira.getJson(`${AGILE}/sprint/${sprint}`)) as Json), "")
        data = (await jira.getJson(`${AGILE}/sprint/${sprint}/issue`, query)) as Json
      } else {
        data = (await jira.getJson(`${AGILE}/board/${backlog_of_board}/backlog`, query)) as Json
      }
      const issues: Json[] = data.issues ?? []
      if (!issues.length) return reply([...head, "No issues."].join("\n"))
      return reply(
        [
          ...head,
          ...issues.map((issue) => issueLine(issue, fields)),
          pageFooter(from, issues.length, typeof data.total === "number" ? data.total : undefined),
        ].join("\n"),
      )
    },
  )

  tool(
    "read",
    "list_epics",
    {
      description: "List the epics of a board: KEY  name  (done or open).",
      inputSchema: z.strictObject({ board, done: z.boolean().optional().describe("Only done (true) or only open (false) epics. Default: all"), start, limit }),
    },
    async ({ board: id, done, start: from = 0, limit: max = 50 }) => {
      const data = (await jira.getJson(`${AGILE}/board/${id}/epic`, { done, startAt: from, maxResults: max })) as Json
      const epics: Json[] = data.values ?? []
      if (!epics.length) return reply(`Board ${id}: no epics.`)
      return reply(
        [...epics.map((e) => `${e.key}  ${e.name ?? e.summary ?? ""}  (${e.done ? "done" : "open"})`), agileFooter(from, epics.length, data)].join("\n"),
      )
    },
  )

  tool(
    "write",
    "move_issues",
    {
      description: "Move up to 50 tickets into a sprint, or back to the backlog: exactly one of `sprint` or `backlog`.",
      inputSchema: z.strictObject({
        issues: z.array(key).min(1).max(50),
        sprint: sprintId.optional(),
        backlog: z.boolean().optional().describe("true to move them to the backlog instead"),
      }),
      idempotent: true,
    },
    async ({ issues, sprint, backlog }) => {
      if ((sprint === undefined) === !backlog) throw new Error("Pass exactly one of `sprint` or `backlog: true`.")
      const keys = issues.map(parseKey)
      if (sprint !== undefined) {
        await jira.sendJson(`${AGILE}/sprint/${sprint}/issue`, { issues: keys }, "POST")
        return reply(`Moved ${keys.join(", ")} to sprint ${sprint}.`)
      }
      await jira.sendJson(`${AGILE}/backlog/issue`, { issues: keys }, "POST")
      return reply(`Moved ${keys.join(", ")} to the backlog.`)
    },
  )

  tool(
    "write",
    "rank_issue",
    {
      description: "Rank tickets before or after another one on the board: exactly one of `before` or `after`.",
      inputSchema: z.strictObject({ issues: z.array(key).min(1).max(50), before: key.optional(), after: key.optional() }),
    },
    async ({ issues, before, after }) => {
      if ((before === undefined) === (after === undefined)) throw new Error("Pass exactly one of `before` or `after`.")
      const keys = issues.map(parseKey)
      const anchor = before !== undefined ? { rankBeforeIssue: parseKey(before) } : { rankAfterIssue: parseKey(after ?? "") }
      await jira.sendJson(`${AGILE}/issue/rank`, { issues: keys, ...anchor }, "PUT")
      return reply(`Ranked ${keys.join(", ")} ${before !== undefined ? "before" : "after"} ${Object.values(anchor)[0]}.`)
    },
  )

  tool(
    "write",
    "create_sprint",
    {
      description: "Create a future sprint on a board. Dates are optional until it starts.",
      inputSchema: z.strictObject({
        board,
        name: z.string(),
        start_date: z.string().optional().describe("ISO 8601"),
        end_date: z.string().optional().describe("ISO 8601"),
        goal: z.string().optional(),
      }),
    },
    async ({ board: originBoardId, name, start_date, end_date, goal }) => {
      const result = (await jira.sendJson(
        `${AGILE}/sprint`,
        { name, originBoardId, startDate: start_date && jiraDate(start_date), endDate: end_date && jiraDate(end_date), goal },
        "POST",
      )) as Json | null
      return reply(`Created sprint ${result?.id ?? "?"} "${result?.name ?? name}" on board ${originBoardId}${result?.state ? ` [${result.state}]` : ""}.`)
    },
  )

  tool(
    "write",
    "update_sprint",
    {
      description: "Rename a sprint, set its dates or goal, start it (state active, needs dates) or close it (state closed).",
      inputSchema: z.strictObject({
        sprint: sprintId,
        name: z.string().optional(),
        start_date: z.string().optional().describe("ISO 8601"),
        end_date: z.string().optional().describe("ISO 8601"),
        goal: z.string().optional(),
        state: z.enum(["future", "active", "closed"]).optional(),
      }),
    },
    async ({ sprint, name, start_date, end_date, goal, state }) => {
      const changes = { name, startDate: start_date && jiraDate(start_date), endDate: end_date && jiraDate(end_date), goal, state }
      const sent = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
      if (!Object.keys(sent).length) throw new Error("Nothing to change: pass at least one field.")
      // A POST to the sprint is Jira's partial update; a PUT would blank every field left out.
      const result = (await jira.sendJson(`${AGILE}/sprint/${sprint}`, sent, "POST")) as Json | null
      return reply(`Updated sprint ${sprint}: ${Object.keys(sent).join(", ")}${result?.state ? `  [${result.state}]` : ""}.`)
    },
  )

  tool(
    "write",
    "create_version",
    {
      description: "Create a version (fix version) in a project.",
      inputSchema: z.strictObject({
        project: z.string().describe("Project key"),
        name: z.string(),
        description: z.string().optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD"),
        release_date: z.string().optional().describe("YYYY-MM-DD"),
        released: z.boolean().optional(),
      }),
    },
    async ({ project, name, description, start_date, release_date, released }) => {
      const result = (await jira.sendJson(
        "/rest/api/2/version",
        { project: project.toUpperCase(), name, description, startDate: start_date, releaseDate: release_date, released },
        "POST",
      )) as Json | null
      return reply(`Created version ${result?.name ?? name} (id ${result?.id ?? "?"}) in ${project.toUpperCase()}.`)
    },
  )

  tool(
    "write",
    "update_version",
    {
      description: "Change a version: rename, describe, set dates, release or archive it. get_project lists version ids.",
      inputSchema: z.strictObject({
        id: z.string().describe("Version id"),
        name: z.string().optional(),
        description: z.string().optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD"),
        release_date: z.string().optional().describe("YYYY-MM-DD"),
        released: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
    },
    async ({ id, name, description, start_date, release_date, released, archived }) => {
      const changes = { name, description, startDate: start_date, releaseDate: release_date, released, archived }
      const sent = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
      if (!Object.keys(sent).length) throw new Error("Nothing to change: pass at least one field.")
      await jira.sendJson(`/rest/api/2/version/${id}`, sent, "PUT")
      return reply(`Updated version ${id}: ${Object.keys(sent).join(", ")}.`)
    },
  )
}
