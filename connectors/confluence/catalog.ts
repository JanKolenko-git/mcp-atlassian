// The Confluence tools by tier, as the server registers them. Tests check tools/list against this.
export const READS = [
  "get_page",
  "search_pages",
  "list_spaces",
  "list_pages",
  "get_children",
  "get_page_history",
  "preview_section_update",
  "preview_page_update",
  "get_attachment",
  "get_comments",
  "whoami",
  "confluence_get",
  "list_templates",
  "get_template",
  "get_restrictions",
  "search_users",
]
export const WRITES = [
  "update_section",
  "create_page",
  "update_page",
  "move_page",
  "copy_page",
  "add_comment",
  "set_labels",
  "add_attachment",
  "create_page_from_template",
  "set_restrictions",
]
export const DELETES = ["delete_page", "delete_comment", "delete_attachment"]
