import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fakeHost, startServer, type Reply, type Seen } from '../shared/testing.ts';
import { DELETES, READS, WRITES } from './catalog.ts';

let routes: (seen: Seen) => Reply = () => ({ status: 204, body: '' });
const confluence = await fakeHost((seen) => routes(seen));
const everything = await startServer(new URL('server.ts', import.meta.url), { CONFLUENCE_URL: confluence.url, CONFLUENCE_PERSONAL_TOKEN: 't', CONFLUENCE_DELETE: 'on' });
const trimmed = await startServer(new URL('server.ts', import.meta.url), { CONFLUENCE_URL: confluence.url, CONFLUENCE_PERSONAL_TOKEN: 't', CONFLUENCE_DELETE: 'off' });

after(async () => {
  await everything.client.close();
  await trimmed.client.close();
  confluence.close();
});

test('CONFLUENCE_DELETE=on offers the three delete tools without the ask marker', async () => {
  const { tools } = await everything.client.listTools();
  assert.equal(tools.length, 22);
  assert.deepEqual([...tools.map((t) => t.name)].sort(), [...READS, ...WRITES, ...DELETES].sort());
  for (const t of tools) assert.equal(t._meta?.['anthropic/requiresUserInteraction'], undefined, t.name);

  routes = (seen) => (seen.method === 'GET' ? { body: { id: '42', title: 'Spec', space: { key: 'ENG' } } } : { status: 204, body: '' });
  assert.equal((await everything.call('delete_page', { page: '42' })).text, 'Moved "Spec" (42) to the trash of space ENG. A space admin can restore it from Space tools → Content Tools → Trash.');
  assert.deepEqual([confluence.seen[1]?.method, confluence.seen[1]?.url], ['DELETE', '/rest/api/content/42']);
  assert.equal((await everything.call('delete_comment', { comment_id: '20' })).text, 'Deleted comment 20.');
  assert.equal((await everything.call('delete_attachment', { attachment_id: '600' })).text, 'Deleted attachment 600.');
  assert.equal(confluence.seen.at(-1)?.url, '/rest/api/content/600');
});

test('CONFLUENCE_DELETE=off leaves the three delete tools out', async () => {
  const { tools } = await trimmed.client.listTools();
  assert.deepEqual([...tools.map((t) => t.name)].sort(), [...READS, ...WRITES].sort());
});
