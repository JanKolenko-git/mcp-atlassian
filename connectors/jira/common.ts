// Shared by the Jira tool modules: the client, key parsing, field lookups and small formatters.
import * as z from "zod"

import { connect } from "../shared/http.ts"
import { markdownToWiki } from "../shared/wiki.ts"

export const jira = connect("Jira")

// The REST payloads are read loosely: any field may be missing or null.
export type Json = Record<string, any>

/** A ticket key from a browse URL, an issue URL, or a bare key. */
export function parseKey(target: string): string {
  const arg = target.trim()
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(arg)) return arg.toUpperCase()
  const browse = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(arg)
  if (browse?.[1]) return browse[1].toUpperCase()
  const query = new URLSearchParams(arg.split("?")[1]?.split("#")[0] ?? "")
  for (const name of ["selectedIssue", "issueKey", "key"]) {
    const value = query.get(name)
    if (value) return value.toUpperCase()
  }
  const anywhere = /([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(arg)
  if (anywhere?.[1]) return anywhere[1].toUpperCase()
  throw new Error(`could not find a ticket key in '${target}'. Pass a key like PROJ-1234 or a /browse/ URL.`)
}

export const browseUrl = (key: string) => `${jira.baseUrl()}/browse/${key}`
export const name = (value: Json | null | undefined) => value?.name || null
export const person = (value: Json | null | undefined) => value?.displayName || null
export const day = (value: string | null | undefined, length = 10) => (value ?? "").slice(0, length) || null
export const when = (value: string | null | undefined) => (day(value, 16) ?? "").replace("T", " ")
// A description or comment body as Jira stored it: wiki markup, which reads as it is.
export const text = (value: string | null | undefined) => (value ?? "").replaceAll("\r\n", "\n").trim()

export const key = z.string().describe("A key like PROJ-1155 or any Jira URL containing one")
export const start = z.number().int().min(0).optional().describe("Row to start at, from the previous footer. Default 0")
export const format = z
  .enum(["wiki", "markdown"])
  .optional()
  .describe("How bodies are written: wiki (default) is Jira wiki markup as is; markdown is converted to it")
export const WIKI = "in Jira wiki markup ({code}...{code}, *bold*, h3.), or Markdown with format: markdown"

/** A body as Jira stores it: wiki markup, converted from Markdown when asked. */
export const asWiki = (body: string, how?: "wiki" | "markdown") => (how === "markdown" ? markdownToWiki(body) : body)

/** Jira's own date-time format for worklogs and sprints: ISO with a numeric offset and no colon. */
export function jiraDate(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) throw new Error(`'${input}' is not a date. Pass ISO 8601, such as 2026-10-15T09:00:00Z or 2026-10-15.`)
  return date.toISOString().replace("Z", "+0000")
}

/** `seconds` as Jira writes durations: 1d 2h 30m, with Jira's 8-hour day. */
export function duration(seconds: number): string {
  const parts: string[] = []
  const days = Math.floor(seconds / 28_800)
  const hours = Math.floor((seconds % 28_800) / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes || !parts.length) parts.push(`${minutes}m`)
  return parts.join(" ")
}

// The field list rarely changes while a server runs, so it is fetched once per process.
let fields: Promise<Json[]> | undefined
export function allFields(): Promise<Json[]> {
  fields ??= (jira.getJson("/rest/api/2/field") as Promise<Json[]>).catch((error: unknown) => {
    fields = undefined
    throw error
  })
  return fields
}

/** The id of the Epic Link custom field, or null on an instance that files epics through `parent`. */
export async function epicLinkField(): Promise<string | null> {
  return (await allFields()).find((field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link")?.id ?? null
}

/** The username the token belongs to. */
export async function myself(): Promise<string> {
  const me = (await jira.getJson("/rest/api/2/myself")) as Json
  if (!me.name) throw new Error("Jira returned no username for the token.")
  return me.name
}

/** One line per issue, the shape every list of issues uses: KEY  [Status]  summary  —  URL. */
export function issueLine(issue: Json, extra: string[] = []): string {
  const fields = issue.fields ?? {}
  const line = `${issue.key}  [${name(fields.status) ?? "?"}]  ${fields.summary ?? ""}  —  ${browseUrl(issue.key)}`
  if (!extra.length) return line
  return `${line}\n    ${extra.map((field) => `${field}: ${briefField(fields[field])}`).join("; ")}`
}

export function briefField(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (Array.isArray(value)) return value.length ? value.map(briefField).join(", ") : "—"
  if (typeof value === "object") {
    const object = value as Json
    for (const field of ["displayName", "name", "value", "key"]) if (typeof object[field] === "string") return object[field]
    return JSON.stringify(value)
  }
  return String(value)
}
