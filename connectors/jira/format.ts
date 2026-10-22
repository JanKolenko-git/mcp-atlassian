// The Markdown a ticket is reported as: metadata bullets, the description, comments, and when
// asked for, the change history and any field beyond the usual ones.
import { formatSize } from "../shared/text.ts"
import { briefField, browseUrl, day, type Json, name, person, text, when } from "./common.ts"

export const FIELDS =
  "summary,description,comment,attachment,issuelinks,labels,priority,status,assignee,reporter," +
  "components,issuetype,created,updated,parent,subtasks,resolution,fixVersions,duedate"

export interface Shown {
  /** Keep only the N most recent comments; 0 leaves comments out; undefined shows all. */
  comments?: number | undefined
  /** Fields beyond the usual ones, shown under their own heading. */
  extra?: string[] | undefined
  changelog?: boolean | undefined
}

export function linkLines(issuelinks: Json[] | null | undefined): string[] {
  const lines: string[] = []
  for (const link of issuelinks ?? []) {
    const linkType = link.type ?? {}
    for (const [direction, labelKey] of [
      ["outwardIssue", "outward"],
      ["inwardIssue", "inward"],
    ] as const) {
      const issue = link[direction]
      if (!issue) continue
      const fields = issue.fields ?? {}
      const label = linkType[labelKey] || linkType.name || "relates to"
      lines.push(`${label} **${issue.key}** (${name(fields.status) ?? "?"}) — ${fields.summary ?? ""}${link.id ? `  (link ${link.id})` : ""}`)
    }
  }
  return lines
}

function changelogLines(issue: Json): string[] {
  const histories: Json[] = issue.changelog?.histories ?? []
  const shown = histories.slice(-40)
  const lines = shown.map((entry) => {
    const changes = (entry.items ?? []).map((item: Json) => `${item.field}: ${item.fromString ?? "—"} → ${item.toString ?? "—"}`).join("; ")
    return `- ${when(entry.created)}  ${person(entry.author) ?? "?"}: ${changes}`
  })
  if (histories.length > shown.length) lines.unshift(`- … ${histories.length - shown.length} earlier entries not shown`)
  return lines
}

/** The ticket summary: metadata bullets, the description, then comments, most recent `comments` of them. */
export function formatIssue(key: string, issue: Json, shown: Shown = {}): string {
  const fields = issue.fields ?? {}
  const lines = [`# ${key} — ${fields.summary ?? "(no summary)"}`, ""]
  const meta: [string, string | null][] = [
    ["Type", name(fields.issuetype)],
    ["Status", name(fields.status)],
    ["Priority", name(fields.priority)],
    ["Resolution", name(fields.resolution)],
    ["Reporter", person(fields.reporter)],
    ["Assignee", person(fields.assignee) ?? "Unassigned"],
    ["Created", day(fields.created)],
    ["Updated", day(fields.updated)],
    ["Due", fields.duedate],
  ]
  for (const [label, value] of meta) if (value) lines.push(`- **${label}:** ${value}`)

  for (const [label, field] of [
    ["Labels", "labels"],
    ["Components", "components"],
    ["Fix versions", "fixVersions"],
  ] as const) {
    const values: (string | Json)[] = fields[field] ?? []
    if (values.length) lines.push(`- **${label}:** ${values.map((v) => (typeof v === "string" ? v : (v.name ?? ""))).join(", ")}`)
  }

  if (fields.parent) lines.push(`- **Parent:** ${fields.parent.key} — ${fields.parent.fields?.summary ?? ""}`)

  const subtasks: Json[] = fields.subtasks ?? []
  if (subtasks.length) {
    lines.push(`- **Subtasks (${subtasks.length}):**`)
    for (const sub of subtasks) lines.push(`  - ${sub.key} (${name(sub.fields?.status) ?? "?"}) — ${sub.fields?.summary ?? ""}`)
  }

  const links = linkLines(fields.issuelinks)
  if (links.length) {
    lines.push(`- **Linked issues (${links.length}):**`)
    for (const link of links) lines.push(`  - ${link}`)
  }

  const attachments: Json[] = fields.attachment ?? []
  if (attachments.length) {
    lines.push(`- **Attachments (${attachments.length}):**`)
    for (const item of attachments) {
      lines.push(`  - ${item.filename} (${item.mimeType ?? "?"}, ${formatSize(item.size || 0)}, id ${item.id ?? "?"}) — ${item.content ?? ""}`)
    }
  }

  lines.push(`- **URL:** ${browseUrl(key)}`)

  const requested = shown.extra ?? []
  if (requested.length) {
    const usual = new Set(FIELDS.split(","))
    const list = requested.includes("*all") ? Object.keys(fields) : requested
    const names: Json = issue.names ?? {}
    const shownLines: string[] = []
    for (const field of list.filter((id) => !usual.has(id))) {
      const value = fields[field]
      if (value === null || value === undefined || (Array.isArray(value) && !value.length)) continue
      shownLines.push(`- **${names[field] ?? field}${names[field] ? ` (${field})` : ""}:** ${briefField(value)}`)
    }
    lines.push("", "## Other fields", "", ...(shownLines.length ? shownLines : ["_(none with a value)_"]))
  }

  lines.push("", "## Description", "", text(fields.description) || "_(no description)_")

  const all: Json[] = fields.comment?.comments ?? []
  if (!all.length) {
    lines.push("", "## Comments", "", "_(none)_")
  } else if (shown.comments !== 0) {
    const kept = shown.comments ? all.slice(-shown.comments) : all
    const omitted = all.length - kept.length
    lines.push("", `## Comments (${all.length})${omitted > 0 ? ` — showing the ${kept.length} most recent` : ""}`)
    for (const comment of kept) {
      lines.push("", `### ${person(comment.author) ?? "?"} — ${when(comment.created)} (comment ${comment.id ?? "?"})`, "", text(comment.body) || "_(empty)_")
    }
  }

  if (shown.changelog) {
    const history = changelogLines(issue)
    lines.push("", "## History", "", ...(history.length ? history : ["_(none)_"]))
  }
  return `${lines.join("\n")}\n`
}
