import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fakeHost, queryOf, startServer, type Reply, type Seen } from '../shared/testing.ts';

let routes: (seen: Seen) => Reply = () => ({ status: 404 });
const confluence = await fakeHost((seen) => routes(seen));
const { client, call } = await startServer(new URL('server.ts', import.meta.url), { CONFLUENCE_URL: confluence.url, CONFLUENCE_PERSONAL_TOKEN: 'test-token' });

beforeEach(() => {
  confluence.seen.length = 0;
});
after(async () => {
  await client.close();
  confluence.close();
});

const page = (storage: string, extra: Record<string, unknown> = {}) => ({
  id: '42', title: 'Spec', space: { key: 'ENG' }, version: { number: 7, when: '2026-10-01T10:00:00Z', by: { displayName: 'Ana' } },
  body: { storage: { value: storage } }, _links: { webui: '/x/42' }, ...extra,
});
const body = (index: number) => JSON.parse(confluence.seen[index]?.body ?? 'null');

test('list_spaces and list_pages', async () => {
  routes = () => ({ body: { results: [{ key: 'ENG', name: 'Engineering', type: 'global', _links: { webui: '/display/ENG' } }, { key: '~ana', name: 'Ana', type: 'personal' }], size: 2, _links: { next: '/rest/api/space?start=2' } } });
  assert.equal((await call('list_spaces', { query: 'eng', limit: 2 })).text, `ENG  Engineering  (global)  —  ${confluence.url}/display/ENG\nshowing 1–2; pass start=2 for more`);
  assert.equal(confluence.seen[0]?.url, '/rest/api/space?status=current&start=0&limit=2');

  routes = () => ({ body: { totalSize: 1, results: [{ id: '42', title: 'Spec', space: { key: 'ENG' }, _links: { webui: '/x/42' } }] } });
  assert.equal((await call('list_pages', { space: 'ENG', title: 'sp' })).text, `42  [ENG]  Spec  —  ${confluence.url}/x/42\nshowing 1–1 of 1`);
  assert.equal(queryOf(confluence.seen, 1).get('cql'), 'type=page AND space="ENG" AND title ~ "sp" ORDER BY title ASC');

  routes = () => ({ body: { results: [{ id: '1', title: 'Home', space: { key: 'ENG' } }, { id: '2', title: 'Archive', space: { key: 'ENG' } }], size: 2 } });
  assert.equal((await call('list_pages', { space: 'ENG', root_only: true, title: 'home' })).text, `1  [ENG]  Home  —  ${confluence.url}/pages/viewpage.action?pageId=1\nshowing 1–1`);
  assert.equal(confluence.seen[2]?.url, '/rest/api/space/ENG/content/page?depth=root&start=0&limit=25&expand=space');
});

test('get_children: direct children, or a subtree rendered from the ancestors', async () => {
  routes = () => ({ body: { results: [{ id: '2', title: 'B', _links: { webui: '/x/2' } }], size: 1 } });
  assert.equal((await call('get_children', { page: '42' })).text, `- B (2) — ${confluence.url}/x/2\nshowing 1–1`);
  assert.equal(confluence.seen[0]?.url, '/rest/api/content/42/child/page?start=0&limit=100&expand=version');

  routes = (seen) =>
    seen.url.includes('/descendant/page')
      ? {
          body: {
            results: [
              { id: '3', title: 'Deep', ancestors: [{ id: '1' }, { id: '42' }, { id: '2' }] },
              { id: '2', title: 'Zeta', ancestors: [{ id: '1' }, { id: '42' }] },
              { id: '4', title: 'Alpha', ancestors: [{ id: '1' }, { id: '42' }] },
              { id: '5', title: 'Too deep', ancestors: [{ id: '1' }, { id: '42' }, { id: '2' }, { id: '3' }] },
            ],
            size: 4,
          },
        }
      : { body: { id: '42', ancestors: [{ id: '1' }] } };
  const tree = await call('get_children', { page: '42', depth: 2 });
  const url = (id: string) => `${confluence.url}/pages/viewpage.action?pageId=${id}`;
  assert.equal(tree.text, [`- Alpha (4) — ${url('4')}`, `- Zeta (2) — ${url('2')}`, `  - Deep (3) — ${url('3')}`, 'showing 1–4'].join('\n'));
});

test('get_page_history lists versions and diffs two of them as Markdown', async () => {
  routes = (seen) => {
    if (seen.url.startsWith('/rest/experimental/content/42/version')) return { body: { results: [{ number: 7, when: '2026-10-01T10:00:00Z', by: { displayName: 'Ana' }, message: 'tidy' }, { number: 6, when: '2026-09-01T09:00:00Z', by: { displayName: 'Bob' }, minorEdit: true }] } };
    if (seen.url.includes('status=historical')) return { body: { body: { storage: { value: '<p>one</p><p>two</p>' } } } };
    return { body: page('<p>one</p><p>three</p>') };
  };
  const history = await call('get_page_history', { page: '42', diff: [6, 7] });
  assert.equal(history.text, ['# Spec — history (current v7)', '', '- v7  2026-10-01 10:00  Ana  — tidy', '- v6  2026-09-01 09:00  Bob  (minor)', '', '## v6 → v7', '', '  one', '  ', '- two', '+ three', ''].join('\n'));
  assert.equal(confluence.seen.find((s) => s.url.includes('status=historical'))?.url, '/rest/api/content/42?status=historical&version=6&expand=body.storage');

  routes = (seen) =>
    seen.url.startsWith('/rest/experimental/')
      ? { status: 404 }
      : seen.url.includes('/history')
        ? { body: { lastUpdated: { number: 7, when: '2026-10-01T10:00:00Z', by: { displayName: 'Ana' } }, previousVersion: { number: 6, when: '2026-09-01T09:00:00Z', by: { displayName: 'Bob' } } } }
        : { body: page('') };
  assert.match((await call('get_page_history', { page: '42' })).text, /- v7 {2}2026-10-01 10:00 {2}Ana\n- v6 {2}2026-09-01 09:00 {2}Bob\n$/);
});

test('create_page: under a parent, Markdown rendered by Confluence, labels added after', async () => {
  routes = (seen) => {
    if (seen.url.startsWith('/rest/api/content?')) return { body: { results: [{ id: '7' }] } };
    if (seen.url.startsWith('/rest/api/contentbody/convert/storage')) return { body: { value: '<h1>T</h1>', representation: 'storage' } };
    if (seen.url === '/rest/api/content') return { body: { id: '99', title: 'New', version: { number: 1 }, _links: { webui: '/x/99' } } };
    return { body: [] };
  };
  const made = await call('create_page', { space: 'ENG', title: 'New', body: '# T', format: 'markdown', parent: 'Parent page', labels: ['draft', 'spec'] });
  assert.equal(made.text, `Created "New" (99, v1) in ENG with labels draft, spec — ${confluence.url}/x/99`);
  assert.equal(queryOf(confluence.seen, 0).get('spaceKey'), 'ENG');
  assert.deepEqual(body(1), { value: 'h1. T', representation: 'wiki' });
  assert.deepEqual(body(2), { type: 'page', title: 'New', space: { key: 'ENG' }, ancestors: [{ id: '7' }], body: { storage: { value: '<h1>T</h1>', representation: 'storage' } } });
  assert.deepEqual([confluence.seen[3]?.url, body(3)], ['/rest/api/content/99/label', [{ prefix: 'global', name: 'draft' }, { prefix: 'global', name: 'spec' }]]);
});

test('update_page: refused on a stale version, previewed as a diff, written as the next version', async () => {
  routes = () => ({ body: page('<p>one</p><p>two</p>') });
  const stale = await call('update_page', { page: '42', expected_version: 6, body: '<p>x</p>' });
  assert.ok(stale.isError);
  assert.match(stale.text, /"Spec" is at version 7 \(2026-10-01 10:00 by Ana\), not 6\. Re-read it/);
  assert.match((await call('update_page', { page: '42', expected_version: 7 })).text, /Nothing to change/);
  assert.ok(confluence.seen.every((s) => s.method === 'GET'));

  routes = (seen) => (seen.url.startsWith('/rest/api/contentbody/') ? { body: { value: '<p>one</p><p>three</p>' } } : { body: page('<p>one</p><p>two</p>') });
  const preview = await call('preview_page_update', { page: '42', expected_version: 7, body: 'one\n\nthree', format: 'markdown', title: 'Spec v2' });
  assert.equal(
    preview.text,
    ['Would update "Spec" (42, v7 -> v8)', 'title: Spec -> Spec v2', '--- body, as Markdown', '  one', '  ', '- two', '+ three', '--- storage to be written', '<p>one</p><p>three</p>', `${confluence.url}/x/42`].join('\n'),
  );
  assert.ok(confluence.seen.every((s) => s.method !== 'PUT'));

  routes = (seen) => (seen.method === 'PUT' ? { body: {} } : seen.url.startsWith('/rest/api/content?') ? { body: { results: [{ id: '5' }] } } : { body: page('<p>one</p>') });
  confluence.seen.length = 0;
  const written = await call('update_page', { page: '42', expected_version: 7, title: 'Spec v2', parent: 'Specs home', message: 'retitle' });
  assert.equal(written.text, `Updated "Spec v2" (42, v7 -> v8): title, parent — ${confluence.url}/x/42`);
  assert.deepEqual(body(2), {
    id: '42', type: 'page', title: 'Spec v2', space: { key: 'ENG' }, ancestors: [{ id: '5' }],
    body: { storage: { value: '<p>one</p>', representation: 'storage' } }, version: { number: 8, message: 'retitle' },
  });
});

test('move_page', async () => {
  routes = () => ({ body: { pageId: '42' } });
  assert.equal((await call('move_page', { page: '42', target: '7' })).text, 'Moved page 42 under 7.');
  assert.deepEqual([confluence.seen[0]?.method, confluence.seen[0]?.url], ['PUT', '/rest/api/content/42/move/append/7']);
  assert.equal((await call('move_page', { page: '42', target: '8', position: 'after' })).text, 'Moved page 42 after 8.');
});
