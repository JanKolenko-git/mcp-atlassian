import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fakeHost, queryOf, startServer, type Reply, type Seen } from '../shared/testing.ts';

let routes: (seen: Seen) => Reply = () => ({ status: 404 });
const jira = await fakeHost((seen) => routes(seen));
const { client, call } = await startServer(new URL('server.ts', import.meta.url), { JIRA_URL: jira.url, JIRA_PERSONAL_TOKEN: 'test-token' });

beforeEach(() => {
  jira.seen.length = 0;
});
after(async () => {
  await client.close();
  jira.close();
});

const body = (index: number) => JSON.parse(jira.seen[index]?.body ?? 'null');

test('comments: add with visibility and Markdown, edit', async () => {
  routes = () => ({ body: { id: '77' } });
  const added = await call('add_comment', { key: 'PROJ-1', body: 'Shipped **it**', format: 'markdown', visibility: { type: 'role', value: 'Developers' } });
  assert.equal(added.text, `Commented on PROJ-1 (comment 77) — ${jira.url}/browse/PROJ-1?focusedCommentId=77`);
  assert.deepEqual(body(0), { body: 'Shipped *it*', visibility: { type: 'role', value: 'Developers' } });

  routes = () => ({ body: { id: '77' } });
  assert.match((await call('edit_comment', { key: 'PROJ-1', comment_id: '77', body: 'fixed' })).text, /^Edited comment 77 on PROJ-1/);
  assert.equal(jira.seen[1]?.method, 'PUT');
  assert.equal(jira.seen[1]?.url, '/rest/api/2/issue/PROJ-1/comment/77');
  assert.deepEqual(body(1), { body: 'fixed' });
});

test('worklogs: listed with a total, added with Jira dates and estimate handling', async () => {
  routes = () => ({
    body: { worklogs: [{ id: '1', author: { displayName: 'Ana' }, started: '2026-10-01T09:00:00.000+0000', timeSpent: '2h', timeSpentSeconds: 7200, comment: 'review' }, { id: '2', author: { displayName: 'Bob' }, started: '2026-10-02T09:00:00.000+0000', timeSpent: '1d', timeSpentSeconds: 28800 }] },
  });
  assert.equal((await call('get_worklogs', { key: 'PROJ-1' })).text, '1  Ana  2026-10-01 09:00  2h  — review\n2  Bob  2026-10-02 09:00  1d\nTotal: 1d 2h in 2 entries');

  routes = () => ({ body: { id: '9', timeSpent: '1h 30m' } });
  const logged = await call('add_worklog', { key: 'PROJ-1', time_spent: '1.5h', started: '2026-10-15T09:00:00Z', comment: 'pairing', adjust: 'new', estimate: '4h' });
  assert.equal(logged.text, `Logged 1h 30m on PROJ-1 (worklog 9) — ${jira.url}/browse/PROJ-1`);
  assert.equal(queryOf(jira.seen, 1).get('adjustEstimate'), 'new');
  assert.equal(queryOf(jira.seen, 1).get('newEstimate'), '4h');
  assert.equal(queryOf(jira.seen, 1).get('reduceBy'), null);
  assert.deepEqual(body(1), { timeSpent: '1.5h', started: '2026-10-15T09:00:00.000+0000', comment: 'pairing' });
  assert.match((await call('add_worklog', { key: 'PROJ-1', time_spent: '1h', adjust: 'manual' })).text, /adjust: manual needs `estimate`/);
  assert.match((await call('add_worklog', { key: 'PROJ-1', time_spent: '1h', started: 'yesterday' })).text, /'yesterday' is not a date/);
});

test('watchers: the token user by default, a named one on request', async () => {
  routes = (seen) => (seen.url.startsWith('/rest/api/2/myself') ? { body: { name: 'ana' } } : { status: 204, body: '' });
  assert.equal((await call('watch_issue', { key: 'PROJ-1' })).text, 'ana now watches PROJ-1');
  assert.equal(jira.seen[1]?.method, 'POST');
  assert.equal(jira.seen[1]?.body, '"ana"');

  assert.equal((await call('watch_issue', { key: 'PROJ-1', watch: false, username: 'bob' })).text, 'bob no longer watches PROJ-1');
  assert.equal(jira.seen[2]?.method, 'DELETE');
  assert.equal(jira.seen[2]?.url, '/rest/api/2/issue/PROJ-1/watchers?username=bob');
});

test('links: by name or phrase, an inward phrase flips the keys, unknown types list what exists', async () => {
  const types = { issueLinkTypes: [{ id: '1', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, { id: '2', name: 'Relates', outward: 'relates to', inward: 'relates to' }] };
  routes = (seen) => (seen.method === 'GET' ? { body: types } : { status: 201, body: '' });
  assert.equal((await call('list_link_types', {})).text, 'Blocks: "blocks" / "is blocked by"\nRelates: "relates to" / "relates to"');

  assert.equal((await call('link_issues', { type: 'blocks', from: 'PROJ-1', to: 'PROJ-2', comment: 'see above' })).text, 'PROJ-1 blocks PROJ-2  (Blocks)');
  assert.deepEqual(body(2), { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-2' }, comment: { body: 'see above' } });

  assert.equal((await call('link_issues', { type: 'is blocked by', from: 'PROJ-1', to: 'PROJ-2' })).text, 'PROJ-2 blocks PROJ-1  (Blocks)');
  assert.deepEqual(body(4), { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-2' }, outwardIssue: { key: 'PROJ-1' } });

  const unknown = await call('link_issues', { type: 'Depends', from: 'PROJ-1', to: 'PROJ-2' });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /no link type 'Depends'.*\n {2}Blocks: "blocks" \/ "is blocked by"/s);
  assert.equal(jira.seen.filter((s) => s.method === 'POST').length, 2);
});

test('remote links: listed and added', async () => {
  routes = () => ({ body: [{ id: '5', object: { title: 'PR 12', url: 'https://git/pr/12' }, relationship: 'fixed by' }] });
  assert.equal((await call('get_remote_links', { key: 'PROJ-1' })).text, '5  PR 12 — https://git/pr/12  (fixed by)');
  routes = () => ({ body: { id: '6' } });
  assert.equal((await call('add_remote_link', { key: 'PROJ-1', url: 'https://wiki/x', title: 'Spec', relationship: 'documented in' })).text, `Linked Spec to PROJ-1 (remote link 6) — ${jira.url}/browse/PROJ-1`);
  assert.deepEqual(body(1), { object: { url: 'https://wiki/x', title: 'Spec' }, relationship: 'documented in' });
  assert.match((await call('add_remote_link', { key: 'PROJ-1', url: 'not a url', title: 'x' })).text, /Invalid arguments/);
});

test('add_attachment uploads a local file as multipart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-jira-'));
  const file = join(dir, 'trace.log');
  await writeFile(file, 'boom');
  routes = () => ({ body: [{ id: '31', filename: 'trace.log', mimeType: 'text/plain', size: 4, content: `${jira.url}/secure/attachment/31/trace.log` }] });
  const sent = await call('add_attachment', { key: 'PROJ-1', path: file });
  assert.equal(sent.text, `Attached trace.log (text/plain, 4 B, id 31) to PROJ-1 — ${jira.url}/secure/attachment/31/trace.log`);
  assert.equal(jira.seen[0]?.url, '/rest/api/2/issue/PROJ-1/attachments');
  assert.equal(jira.seen[0]?.headers['x-atlassian-token'], 'no-check');
  assert.match(jira.seen[0]?.body ?? '', /filename="trace.log"\r\nContent-Type: text\/plain\r\n\r\nboom/);
  assert.match((await call('add_attachment', { key: 'PROJ-1', path: 'trace.log' })).text, /not an absolute path/);
});
