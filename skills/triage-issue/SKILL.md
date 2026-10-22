---
name: triage-issue
description:
  Decide whether a bug report, error message or stack trace duplicates an existing Jira ticket, then
  comment on that ticket or create a new one. Use when the user pastes an error, describes a bug, or
  asks "is this known?".
---

# Triage an issue against Jira

The jira MCP server's tools do the lookups. Nothing is written until the user says so.

## 1. Pull out the signature

From the report, note the error text or exception name, the component or service, the environment
(prod, staging, a version), and the symptom in the user's words. Strip identifiers that vary per
run: ids, timestamps, hostnames.

## 2. Search for duplicates

Run two or three `search_issues` calls, widest last, resolved tickets included so regressions show:

- `text ~ "<exact error phrase>"` scoped to the project if one is known
- `summary ~ "<component> <symptom words>" ORDER BY updated DESC`
- `project = X AND component = "<component>" AND created >= -90d` when the component is certain

Read the two or three closest hits with `get_issue` (`comments: 5`) before judging them.

## 3. Grade and present

Grade each candidate high (same error and component), medium (same component or same symptom) or
low. Report them as `KEY [Status] summary — why it matches`, then one recommendation: comment on
KEY, or create a new ticket. Stop and wait for the user's decision.

## 4. Act on the decision

- **Comment**: `add_comment` with one or two lines: the environment, the exact error, where it
  appeared. Wiki markup, or `format: markdown`.
- **New ticket**: `get_issue_fields` with the project and type first, so required fields are known.
  Then `create_issue` with summary `[Component] [Error type] - <symptom>` and a description under
  `h3.` headings: Problem, Evidence, Impact, Steps to reproduce, dropping empty ones. Link it to a
  related ticket with `link_issues` when one surfaced in step 3.

## 5. Confirm

Report the key and link, and what happens next: who to assign, or a transition the user may want.

## Edge cases

- Several plausible duplicates: list them all; never comment on more than one.
- No project named and the search spans several: ask which project owns the component.
- Too little detail to search: ask for the error text or a screenshot, then `get_attachment` reads
  it.
- A resolved match with a fix version: say so, and ask whether this is a regression worth a new
  ticket linked with the Relates type.
