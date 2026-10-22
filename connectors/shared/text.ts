// Text helpers shared by both servers: sizes, list footers, and the compact form of a value.

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The line under a list: which rows were shown, how many there are when the API said, and the
 * `start` that fetches the next rows when there are more.
 */
export function pageFooter(start: number, shown: number, total?: number, more?: boolean): string {
  const range = shown ? `${start + 1}–${start + shown}` : "0"
  const rest = more ?? (total !== undefined && start + shown < total)
  const count = total !== undefined ? ` of ${total.toLocaleString("en-US")}` : ""
  return `showing ${range}${count}${rest ? `; pass start=${start + shown} for more` : ""}`
}

/** A REST value on one line: a named thing by its name, a person by display name, a list joined. */
export function brief(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (Array.isArray(value)) return value.length ? value.map(brief).join(", ") : "—"
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    for (const field of ["displayName", "name", "value", "key", "id"]) {
      if (typeof object[field] === "string" || typeof object[field] === "number") return String(object[field])
    }
    return JSON.stringify(value)
  }
  return String(value)
}

/** A string literal for JQL or CQL: both quote with double quotes and escape with a backslash. */
export const quoted = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
