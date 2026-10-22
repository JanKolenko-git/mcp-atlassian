// Markdown to the wiki markup Jira and Confluence Server share: what a model writes most
// reliably, turned into what the products store. The everyday subset is covered; anything
// else passes through as written.

const FENCE = /^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())

/** Inline Markdown on one line. Code spans go first, so nothing inside them is touched. */
export function inlineToWiki(text: string): string {
  const spans: string[] = []
  const held = text.replace(/`([^`]+)`/g, (_, code: string) => `\u0000${spans.push(code) - 1}\u0000`)
  const converted = held
    .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, "!$1!")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "[$1|$2]")
    // Bold is held as \u0001 while italics are converted, since both use the asterisk.
    .replace(/\*\*(.+?)\*\*/g, "\u0001$1\u0001")
    .replace(/__(.+?)__/g, "\u0001$1\u0001")
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, "$1_$2_")
    .replace(/~~(.+?)~~/g, "-$1-")
    .replaceAll("\u0001", "*")
  // oxlint-disable-next-line no-control-regex
  return converted.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `{{${spans[Number(index)] ?? ""}}}`)
}

export function markdownToWiki(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const out: string[] = []
  // The open list levels by indentation, so a nested item gets one marker per level: ** or #*.
  const lists: { indent: number; marker: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const fence = FENCE.exec(line)
    if (fence) {
      lists.length = 0
      const closing = (fence[1] ?? "```").slice(0, 3)
      const body: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(closing); i++) body.push(lines[i] ?? "")
      out.push(fence[2] ? `{code:${fence[2]}}` : "{code}", ...body, "{code}")
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      lists.length = 0
      out.push(`||${cells(line).map(inlineToWiki).join("||")}||`)
      // An empty wiki cell needs a space, or the two bars read as a header cell.
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i] ?? ""); i++)
        out.push(
          `|${cells(lines[i] ?? "")
            .map((cell) => inlineToWiki(cell) || " ")
            .join("|")}|`,
        )
      i--
      continue
    }
    if (QUOTE.test(line)) {
      lists.length = 0
      const body: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i] ?? ""); i++) body.push(QUOTE.exec(lines[i] ?? "")?.[1] ?? "")
      i--
      const inner = markdownToWiki(body.join("\n")).trim()
      if (body.length === 1) out.push(`bq. ${inner}`)
      else out.push("{quote}", inner, "{quote}")
      continue
    }
    if (RULE.test(line)) {
      lists.length = 0
      out.push("----")
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const indent = (item[1] ?? "").replaceAll("\t", "    ").length
      const marker = item[2] ? "*" : "#"
      while (lists.length && indent < (lists.at(-1)?.indent ?? 0)) lists.pop()
      const top = lists.at(-1)
      if (!top || indent > top.indent) lists.push({ indent, marker })
      else top.marker = marker
      out.push(`${lists.map((level) => level.marker).join("")} ${inlineToWiki(item[4] ?? "")}`)
      continue
    }
    if (!line.trim()) {
      // A blank line would end a wiki list, so one between items of the same list is dropped.
      const next = ITEM.exec(lines.slice(i + 1).find((rest) => rest.trim()) ?? "")
      if (lists.length && next && (next[2] ? "*" : "#") === lists[0]?.marker) continue
      lists.length = 0
      out.push("")
      continue
    }
    lists.length = 0
    const heading = HEADING.exec(line)
    if (heading) out.push(`h${heading[1]?.length ?? 1}. ${inlineToWiki(heading[2] ?? "")}`)
    else out.push(inlineToWiki(line))
  }
  return `${out.join("\n").trim()}${markdown.endsWith("\n") ? "\n" : ""}`
}
