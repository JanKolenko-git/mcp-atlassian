// A line diff for showing what a page update changes: the rows that differ with a little
// context, long unchanged runs folded.

type Op = { kind: " " | "-" | "+"; text: string }
const MAX_LINES = 4000

function ops(a: string[], b: string[]): Op[] {
  // Longest common subsequence lengths from each (i, j) to the end, then a walk along them.
  const n = a.length
  const m = b.length
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] ?? new Uint32Array(m + 1)
    const below = table[i + 1] ?? new Uint32Array(m + 1)
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i++] ?? "" })
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) out.push({ kind: "-", text: a[i++] ?? "" })
    else out.push({ kind: "+", text: b[j++] ?? "" })
  }
  while (i < n) out.push({ kind: "-", text: a[i++] ?? "" })
  while (j < m) out.push({ kind: "+", text: b[j++] ?? "" })
  return out
}

/** The lines that differ between `before` and `after`, each prefixed `-`, `+` or two spaces. */
export function diffLines(before: string, after: string, context = 3): string {
  const a = before.split("\n")
  const b = after.split("\n")
  if (a.length > MAX_LINES || b.length > MAX_LINES) return `(too long to diff: ${a.length} and ${b.length} lines)`
  const all = ops(a, b)
  if (all.every((op) => op.kind === " ")) return "(no changes)"
  const keep = Array.from({ length: all.length }, () => false)
  all.forEach((op, at) => {
    if (op.kind === " ") return
    for (let k = Math.max(0, at - context); k <= Math.min(all.length - 1, at + context); k++) keep[k] = true
  })
  const lines: string[] = []
  let folded = 0
  const flush = () => {
    if (folded) lines.push(`… ${folded} unchanged line${folded === 1 ? "" : "s"} …`)
    folded = 0
  }
  all.forEach((op, at) => {
    if (!keep[at]) return void folded++
    flush()
    lines.push(`${op.kind === " " ? " " : op.kind} ${op.text}`)
  })
  flush()
  return lines.join("\n")
}
