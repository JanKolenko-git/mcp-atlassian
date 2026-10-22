// Development information: the pull requests, branches and commits a repository integration
// (Bitbucket, GitHub, GitLab) links to a ticket, from the endpoint behind the Development panel.
import * as z from "zod"

import { reply, type Tool } from "../shared/registry.ts"
import { jira, type Json, key, parseKey, when } from "./common.ts"

const DATA_TYPES = ["pullrequest", "branch", "repository"] as const
type DataType = (typeof DATA_TYPES)[number]

const firstLine = (text: string | null | undefined) => (text ?? "").split("\n")[0]?.trim() ?? ""
const stamp = (value: unknown) => (typeof value === "number" ? when(new Date(value).toISOString()) : when(typeof value === "string" ? value : null))

/** The instance types (stash, bitbucket, github, gitlab...) that hold each kind of data, from the summary. */
function instancesByType(summary: Json): Map<DataType, string[]> {
  const found = new Map<DataType, string[]>()
  for (const type of DATA_TYPES) {
    const byInstance: Json = summary.summary?.[type]?.byInstanceType ?? {}
    const names = Object.entries(byInstance)
      .filter(([, info]) => Number((info as Json)?.count ?? 0) > 0)
      .map(([name]) => name)
    if (names.length) found.set(type, names)
  }
  return found
}

function pullRequestLine(pr: Json): string {
  const reviewers: Json[] = pr.reviewers ?? []
  const approved = reviewers.filter((r) => r.approved).length
  const parts = [
    `  ${pr.id ?? "?"}  ${String(pr.status ?? "?").toUpperCase()}  ${pr.name ?? "(untitled)"}`,
    `by ${pr.author?.name ?? "?"}`,
    pr.lastUpdate ? `updated ${stamp(pr.lastUpdate)}` : "",
    pr.source?.branch ? `${pr.source.branch} -> ${pr.destination?.branch ?? "?"}` : "",
    reviewers.length ? `${approved}/${reviewers.length} approved` : "",
    Number(pr.commentCount ?? 0) > 0 ? `${pr.commentCount} comments` : "",
  ].filter(Boolean)
  return `${parts.join("  ")}  — ${pr.url ?? "?"}`
}

function branchLine(branch: Json): string {
  const last = branch.lastCommit
  const tail = last ? `  (last commit ${last.displayId ?? last.id ?? "?"} ${stamp(last.authorTimestamp)})` : ""
  return `  ${branch.name ?? "?"}  in ${branch.repository?.name ?? "?"}${tail}  — ${branch.url ?? "?"}`
}

function commitLine(commit: Json, repository: string): string {
  const files = Array.isArray(commit.files) ? `  ${commit.files.length} files` : ""
  return `  ${commit.displayId ?? String(commit.id ?? "?").slice(0, 7)}  ${stamp(commit.authorTimestamp)}  ${commit.author?.name ?? "?"}  ${firstLine(commit.message)}  [${repository}]${files}  — ${commit.url ?? "?"}`
}

export function registerDevelopment(tool: Tool) {
  tool(
    "read",
    "get_development_info",
    {
      description:
        "The pull requests, branches and commits a repository integration (Bitbucket, GitHub, GitLab) links to a ticket, as its Development panel shows them: " +
        "pull requests with state, author, reviewers and URL, then branches, then commits newest first. Empty when nothing is linked; an error when no integration is installed.",
      inputSchema: z.strictObject({ key }),
    },
    async ({ key: target }) => {
      const issueKey = parseKey(target)
      const issue = (await jira.getJson(`/rest/api/2/issue/${issueKey}`, { fields: "summary" })) as Json
      let summary: Json
      try {
        summary = (await jira.getJson("/rest/dev-status/1.0/issue/summary", { issueId: issue.id })) as Json
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("HTTP 404")) {
          throw new Error(
            `the development information endpoint is not on this Jira: no repository integration (Bitbucket, GitHub, GitLab) is installed, so ${issueKey} has no Development panel.`,
          )
        }
        throw error
      }
      const wanted = instancesByType(summary)
      if (!wanted.size) return reply(`${issueKey}: no pull requests, branches or commits linked.`)

      const pullRequests: Json[] = []
      const branches: Json[] = []
      const commits: { commit: Json; repository: string }[] = []
      const errors: string[] = []
      const instances = new Set<string>()
      for (const [dataType, applicationTypes] of wanted) {
        for (const applicationType of applicationTypes) {
          const data = (await jira.getJson("/rest/dev-status/1.0/issue/detail", { issueId: issue.id, applicationType, dataType })) as Json
          for (const problem of data.errors ?? []) errors.push(typeof problem === "string" ? problem : (problem?.message ?? JSON.stringify(problem)))
          for (const detail of data.detail ?? []) {
            if (detail._instance?.name) instances.add(detail._instance.name)
            pullRequests.push(...(detail.pullRequests ?? []))
            branches.push(...(detail.branches ?? []))
            for (const repository of detail.repositories ?? [])
              for (const commit of repository.commits ?? []) commits.push({ commit, repository: repository.name ?? "?" })
          }
        }
      }
      const byTime = (a: unknown, b: unknown) => Number(b ?? 0) - Number(a ?? 0)
      commits.sort((a, b) => byTime(a.commit.authorTimestamp, b.commit.authorTimestamp))

      const lines = [`${issueKey} — development information${instances.size ? ` (${[...instances].join(", ")})` : ""}`]
      lines.push("", `Pull requests (${pullRequests.length}):`, ...pullRequests.map(pullRequestLine))
      lines.push("", `Branches (${branches.length}):`, ...branches.map(branchLine))
      lines.push("", `Commits (${commits.length}):`, ...commits.map(({ commit, repository }) => commitLine(commit, repository)))
      if (errors.length) lines.push("", `Errors from the integration: ${errors.join("; ")}`)
      return reply(lines.join("\n"))
    },
  )
}
