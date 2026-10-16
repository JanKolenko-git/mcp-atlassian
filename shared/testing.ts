// Test helpers: a fake Atlassian host that records every request, and a server under test,
// started as Claude Code starts it, a child process over stdio, and reached through the SDK client.
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}
export type Reply = { status?: number; headers?: Record<string, string>; body?: unknown };

/** A local HTTP server that records every request and answers with `reply`. */
export async function fakeHost(reply: (seen: Seen) => Reply) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const entry = { method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, headers: request.headers, body };
    seen.push(entry);
    const { status = 200, headers = { 'content-type': 'application/json' }, body: answer = {} } = reply(entry);
    response.writeHead(status, headers).end(typeof answer === 'string' || Buffer.isBuffer(answer) ? answer : JSON.stringify(answer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/** The server at `entry`, running with `env`, and a `call` that returns a tool result as text. */
export async function startServer(entry: URL, env: Record<string, string>) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(entry)], env }));
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return { text: content.map((block) => block.text ?? '').join(''), isError: result.isError === true, content };
  }
  return { client, call };
}

/** The query string of the request at `index`, for assertions on parameters. */
export const queryOf = (seen: Seen[], index: number) => new URL(seen[index]?.url ?? '/', 'http://host').searchParams;
