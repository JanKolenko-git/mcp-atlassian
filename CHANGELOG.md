# Changelog

## 1.0.0 — 2026-10-16

First release of `mcp-atlassian`, a Claude Code plugin with MCP servers for Jira and Confluence
Server or Data Center. Install with `claude plugin install mcp-atlassian@jankolenko`.

### Jira (40 tools)

- Reads: `get_issue`, `search_issues`, `list_transitions`, `get_attachment`, `get_worklogs`,
  `list_link_types`, `get_remote_links`, `list_projects`, `get_project`, `get_issue_fields`,
  `list_fields`, `search_users`, `whoami`, `list_boards`, `list_sprints`, `get_sprint_issues`,
  `list_epics`, `jira_get`.
- Writes: `create_issue`, `create_issues`, `edit_issue`, `transition_issue`, `add_comment`,
  `edit_comment`, `add_worklog`, `add_attachment`, `watch_issue`, `link_issues`,
  `add_remote_link`, `move_issues`, `rank_issue`, `create_sprint`, `update_sprint`,
  `create_version`, `update_version`.
- Deletes: `delete_issue`, `delete_comment`, `delete_worklog`, `delete_attachment`,
  `unlink_issues`.

### Confluence (22 tools)

- Reads: `get_page`, `search_pages`, `get_attachment`, `list_spaces`, `list_pages`,
  `get_children`, `get_page_history`, `get_comments`, `preview_page_update`,
  `preview_section_update`, `whoami`, `confluence_get`.
- Writes: `create_page`, `update_page`, `update_section`, `move_page`, `add_comment`,
  `set_labels`, `add_attachment`.
- Deletes: `delete_page`, `delete_comment`, `delete_attachment`.

### Plugin

- Each tier is set per product to `on`, `ask` or `off`: `jira_read`, `jira_write`, `jira_delete`,
  `confluence_read`, `confluence_write`, `confluence_delete`. Defaults: reads and writes `on`,
  deletes `ask`. `ask` marks the tier's tools with `anthropic/requiresUserInteraction`, so Claude
  Code prompts on every call in every permission mode.
- For other MCP clients the same settings are `JIRA_READ`, `JIRA_WRITE`, `JIRA_DELETE` and the
  Confluence three; `JIRA_MAX_UPLOAD_MB` and `CONFLUENCE_MAX_UPLOAD_MB` cap `add_attachment`.
- Bodies take `format: "markdown"` (and `format: "wiki"` in Confluence); `update_page` refuses a
  stale `expected_version`.
- Skills `triage-issue`, `status-report` and `spec-to-backlog`.
- `setup.sh`: a guided install that checks Node and Claude Code, installs the plugin, tries each
  token against the host and saves the options.
- Every tool carries `openWorldHint: false`; deletes carry `destructiveHint: true`.
