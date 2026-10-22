---
name: status-report
description:
  Write a status report for a Jira project, sprint or filter and, on request, publish it to a
  Confluence page section. Use for "status update", "sprint summary", "what changed this week", or a
  recurring report page.
---

# Status report from Jira, published to Confluence

## 1. Scope

Settle three things with the user, or take them from the request: the scope (a project key, a
sprint, or a JQL filter), the period (default: the last 7 days), and where the report goes (chat
only, or a Confluence page).

## 2. Gather

- Sprint scope: `list_sprints` with `state: ["active"]`, then `get_sprint_issues` with
  `fields: ["assignee", "issuetype", "priority"]`.
- Project or filter scope: `search_issues` with JQL such as
  `project = X AND updated >= -7d ORDER BY status`, `limit: 100`, paging with `start` when the
  footer says so.
- Done this period: `... AND status changed to Done after -7d` (or the project's done status).
- Blocked or stale: `... AND status = "In Progress" AND updated <= -5d`.

Read a ticket with `get_issue` only when its summary is not enough to describe the change.

## 3. Write

Keep it to what a reader who was away for the week needs:

- **Headline**: one sentence on where things stand.
- **Done**: `KEY summary` lines, grouped by epic or component when there are more than eight.
- **In progress**: the same, with the assignee.
- **Blocked or at risk**: each with the reason from the latest comment.
- **Next**: what the sprint goal or the backlog top says comes next.

Numbers belong in a short table; keep them out of the prose.

## 4. Publish, only on the user's word

To a Confluence page, use the marker-delimited section so later reports replace only their own
block:

1. `preview_section_update` with `page`, `marker: "status-report:<SCOPE>"`,
   `heading: "Status report"`, `content` in Markdown with `format: markdown`.
2. Show the user the preview. On their go-ahead, `update_section` with the same arguments.

For a new page instead, `create_page` under the team's reports parent, with
`labels: ["status-report"]`. A refusal (a lone marker, a version mismatch, a 409) is reported as is.
