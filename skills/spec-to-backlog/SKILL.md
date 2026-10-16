---
name: spec-to-backlog
description: Turn a Confluence spec or requirements page into a Jira epic and stories, linked back to the page. Use for "break this spec into tickets", "create the backlog for this page", or "make stories from this document".
---

# From a Confluence spec to a Jira backlog

## 1. Read the spec

`get_page` on the URL or title. Read attachments the text leans on with `get_attachment`. Note the
headings: they usually map to stories. Read at most 3 pages before checking in.

## 2. Draft the breakdown in chat

Propose one epic and its stories as a list the user can edit:

- Epic: `<title>` — one line of scope
- Story: `<title>` — acceptance criteria in two or three bullets, the spec section it comes from

Keep stories to what one person finishes in a few days. Flag anything in the spec that is undecided
as an open question, not a story. Wait for the user's edits and go-ahead.

## 3. Find out what the project needs

`get_issue_fields` with the project and type `Epic`, then `Story`: required fields differ per
project, and the epic may need an Epic Name field. `list_fields` with `query: "epic"` shows the ids
when a custom field is required.

## 4. Create, in order

1. `create_issue` for the epic, description in Markdown with `format: markdown`, linking the spec in
   the first line.
2. `create_issues` with the stories, each with `epic: <EPIC-KEY>`, acceptance criteria under an
   `h3. Acceptance criteria` heading, and `labels` if the team uses them. The result names each key
   and any refusal with Jira's own message; fix refusals one at a time with `create_issue`.
3. `add_remote_link` from the epic to the Confluence page, title "Spec".

## 5. Close the loop on the page, only on the user's word

`preview_section_update` with `marker: "backlog:<EPIC-KEY>"`, `heading: "Jira backlog"`, listing the
epic and stories as links, then `update_section` after the user has seen the preview. Report every
key created, and the stories that were refused and why.
