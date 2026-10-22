// HTTP for Jira or Confluence Server / Data Center, with a personal access token sent as a
// Bearer credential. Atlassian Cloud is a different API with different auth.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import type { Product } from "./registry.ts"
import { formatSize } from "./text.ts"

const TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5
// The image types Claude reads (vision docs, 2026-10).
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

export type Query = Record<string, string | number | boolean | string[] | undefined>
export interface Upload {
  name: string
  bytes: Buffer
  mimeType: string
}
export type Method = "GET" | "POST" | "PUT" | "DELETE"

function origin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return "invalid"
  }
}

/** `path` with `query` appended. An undefined value is left out; an array repeats its key. */
export function withQuery(path: string, query?: Query): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    // Commas stay readable: both products accept them raw, and the URLs read better in errors and tests.
    for (const one of Array.isArray(value) ? value : [value])
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(one)).replaceAll("%2C", ",")}`)
  }
  return parts.length ? `${path}${path.includes("?") ? "&" : "?"}${parts.join("&")}` : path
}

/**
 * The HTTP client for one product. Its URL and token are read from the environment on every call,
 * so a missing option is a tool error the model can relay, not a server that fails to start.
 */
export function connect(product: Product) {
  const envUrl = `${product.toUpperCase()}_URL`
  const envToken = `${product.toUpperCase()}_PERSONAL_TOKEN`
  const setting = `/plugin → mcp-atlassian → Configure options`

  function baseUrl(): string {
    const url = process.env[envUrl] ?? ""
    if (!url) throw new Error(`${envUrl} is not set. Enter your ${product} Data Center address under ${setting}.`)
    if (origin(url) === "invalid") throw new Error(`${envUrl} is '${url}', which is not an address. Enter it with https:// under ${setting}.`)
    return url.replace(/\/+$/, "")
  }

  function token(): string {
    const value = process.env[envToken] ?? ""
    if (!value) {
      throw new Error(
        `${envToken} is not set. In ${product}, open the profile menu → Personal Access Tokens, create one, ` +
          `then enter it under ${setting}. Tokens are per product: a token for the other product gets a 401 here.`,
      )
    }
    return value
  }

  /** A path becomes a URL on the instance; an absolute URL passes through to the host guard. */
  function absolute(url: string): string {
    return /^https?:\/\//.test(url) ? url : `${baseUrl()}${url}`
  }

  const ssoMessage =
    `redirected to the Microsoft SSO login page instead of reaching the ${product} API, so the request ` +
    `never arrived. This is a network problem, not a token problem: connect to the corporate network or ` +
    `VPN and retry. If it persists while on VPN, ${envToken} may have been revoked; create a fresh one in ${product}.`

  function failure(status: number, url: string, method: Method, detail: string): Error {
    const writing = method !== "GET"
    if (status === 401) return new Error(`HTTP 401 — ${envToken} was rejected. It has probably expired; create a fresh one in ${product}.`)
    if (status === 403 && writing) return new Error(`HTTP 403 — the token is valid but this account may not change ${url}. ${detail}`)
    if (status === 403) return new Error(`HTTP 403 — no access to ${url}`)
    if (status === 404 && url.includes("/rest/agile/")) {
      return new Error(
        `HTTP 404 — not found: ${url}. If every /rest/agile call fails this way, Jira Software (boards and sprints) is not installed or licensed here.`,
      )
    }
    if (status === 404) return new Error(`HTTP 404 — not found: ${url}`)
    if (status === 409) {
      return new Error("HTTP 409 — it changed since it was read, so writing now would overwrite someone else's edit. Re-read it and apply the update again.")
    }
    if (status === 413)
      return new Error(`HTTP 413 — the upload is larger than ${product} accepts. Send a smaller file, or ask an admin about the attachment size limit.`)
    if (status === 429) return new Error(`HTTP 429 — ${product} is rate limiting this account. Wait a minute, then retry.`)
    // A 400 on a write usually names the field the screen does not accept, so it is passed through.
    return new Error(`HTTP ${status} — ${detail}`)
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
      const reason = !(cause instanceof Error) ? String(cause) : "code" in cause && typeof cause.code === "string" ? cause.code : cause.message
      throw new Error(`cannot reach ${url} (${reason}). Is the host right, and are you on the network or VPN it sits behind?`, {
        cause: error,
      })
    }
  }

  interface Call {
    method?: Method
    accept?: string
    body?: string | FormData
  }

  /**
   * Every HTTP call goes through here: the token is sent to the instance's own origin only, and a
   * redirect is followed only while it stays there, because a redirect elsewhere would carry it along.
   */
  async function request(url: string, call: Call = {}): Promise<{ bytes: Buffer; contentType: string }> {
    const base = baseUrl()
    if (origin(url) !== origin(base)) {
      throw new Error(`refusing to send ${envToken} to ${url}: it goes only to ${base}. Use the URL ${product} itself lists.`)
    }
    const method = call.method ?? "GET"
    const accept = call.accept ?? "application/json"
    const headers: Record<string, string> = { Authorization: `Bearer ${token()}`, Accept: accept }
    if (typeof call.body === "string") headers["Content-Type"] = "application/json"
    // Both products refuse a multipart upload without this header, their cross-site request check.
    if (call.body instanceof FormData) headers["X-Atlassian-Token"] = "no-check"

    let current = url
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const response = await send(current, { method, headers, ...(call.body !== undefined && { body: call.body }) })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).href
        if (next.includes("login.microsoftonline.com") || next.includes("/openid-login")) throw new Error(ssoMessage)
        if (origin(next) !== origin(base)) {
          throw new Error(`${product} redirected ${current} to ${next}, off ${base}. The token is not sent there, so the request stopped.`)
        }
        current = next
        continue
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!response.ok) throw failure(response.status, url, method, bytes.toString("utf8").slice(0, 400))
      // Only when JSON was asked for: an attachment may legitimately be HTML.
      if (accept.includes("json") && bytes.subarray(0, 512).toString("utf8").trimStart().startsWith("<")) {
        throw new Error(
          `expected JSON from ${current} but got an HTML page — most likely a login or captive portal in front of ${product} rather than ${product} itself.`,
        )
      }
      return { bytes, contentType: response.headers.get("content-type") ?? "" }
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url}; stopped.`)
  }

  const parse = (bytes: Buffer): unknown => {
    const text = bytes.toString("utf8")
    return text.trim() ? JSON.parse(text) : null
  }

  async function getJson(path: string, query?: Query): Promise<unknown> {
    return parse((await request(absolute(withQuery(path, query)))).bytes)
  }

  /**
   * Writes stay in this one function and `upload`, the two places to audit what can change a
   * ticket or a page. Jira answers a transition, a field edit or a delete with 204 No Content.
   */
  async function sendJson(path: string, payload: unknown, method: "POST" | "PUT" | "DELETE", query?: Query): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    return parse((await request(absolute(withQuery(path, query)), { method, body })).bytes)
  }

  /** A multipart upload of one file, with any extra form fields the endpoint takes. */
  async function upload(path: string, file: Upload, fields: Record<string, string> = {}): Promise<unknown> {
    const form = new FormData()
    // A copy into a fresh ArrayBuffer: a Buffer may sit on a shared one, which a Blob does not take.
    form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name)
    for (const [name, value] of Object.entries(fields)) form.append(name, value)
    return parse((await request(absolute(path), { method: "POST", body: form })).bytes)
  }

  /** An attachment as a tool result Claude can read: an image, text, or its name and size otherwise. */
  async function attachment(url: string): Promise<CallToolResult> {
    const target = absolute(url)
    const { bytes, contentType } = await request(target, { accept: "*/*" })
    // Jira writes a space in an attachment path as +, and a literal + as %2B.
    const name = decodeURIComponent((new URL(target).pathname.split("/").pop() ?? "attachment").replaceAll("+", " "))
    const mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    const summary = `${name} (${mimeType || "unknown type"}, ${formatSize(bytes.length)})`
    // Neither is cut here: Claude Code scales a large image to fit and saves a long text to a file (MCP docs, 2026-10).
    if (IMAGE_TYPES.includes(mimeType))
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: bytes.toString("base64"), mimeType },
        ],
      }
    const text = bytes.toString("utf8")
    // Logs often arrive as application/octet-stream, so text is recognised by its bytes too.
    if (!text.includes("\u0000") && !text.includes("�")) return { content: [{ type: "text", text: `${summary}\n\n${text}` }] }
    return { content: [{ type: "text", text: `${summary}: not an image or text, so it is not shown.` }] }
  }

  /** The read-only escape hatch: any GET under /rest/ on the host, as pretty JSON. */
  async function rawGet(path: string, query?: Query): Promise<string> {
    if (!path.startsWith("/rest/")) throw new Error(`'${path}' is not a REST path. Pass one that starts with /rest/, such as /rest/api/2/serverInfo.`)
    return JSON.stringify(await getJson(path, query), null, 2)
  }

  return { baseUrl, getJson, sendJson, upload, attachment, rawGet }
}
