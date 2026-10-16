import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fakeHost, queryOf, startServer, type Reply, type Seen } from '../shared/testing.ts';
import { DELETES, READS, WRITES } from './catalog.ts';
import { htmlToMarkdown } from './markdown.ts';

let routes: (seen: Seen) => Reply = () => ({ status: 404 });
const confluence = await fakeHost((seen) => routes(seen));
const elsewhere = await fakeHost(() => ({ body: 'should never be reached' }));
const { client, call } = await startServer(new URL('server.ts', import.meta.url), {
  CONFLUENCE_URL: confluence.url,
  CONFLUENCE_PERSONAL_TOKEN: 'test-token',
});

beforeEach(() => {
  confluence.seen.length = 0;
  elsewhere.seen.length = 0;
});

after(async () => {
  await client.close();
  confluence.close();
  elsewhere.close();
});

export const page = (storage: string) => ({
  id: '42',
  title: 'Spec',
  space: { key: 'ENG' },
  version: { number: 7 },
  body: { storage: { value: storage } },
  _links: { webui: '/spaces/ENG/pages/42/Spec' },
});
const titleLookups = () =>
  confluence.seen.filter((s) => s.url.startsWith('/rest/api/content?')).map((s) => new URL(s.url, confluence.url).searchParams);

test('tools/list: 22 tools by default, deletes asking, previews read-only, tiers in the annotations', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 22);
  assert.deepEqual([...tools.map((t) => t.name)].sort(), [...READS, ...WRITES, ...DELETES].sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(t.annotations?.readOnlyHint, READS.includes(t.name), t.name);
    assert.equal(t.annotations?.destructiveHint === true, DELETES.includes(t.name), t.name);
    assert.equal(t._meta?.['anthropic/requiresUserInteraction'] === true, DELETES.includes(t.name), t.name);
  }
  assert.match(client.getInstructions() ?? '', /only after its preview tool/);
});

test('get_page: a header with attachments, then the view body as Markdown', async () => {
  routes = () => ({
    body: {
      ...page(''),
      space: { key: 'ENG', name: 'Engineering' },
      version: { number: 3, when: '2026-10-01T10:00:00Z', by: { displayName: 'Ana' } },
      ancestors: [{ title: 'Home' }, { title: 'Specs' }],
      children: { attachment: { results: [{ id: '501', title: 'flow.png', metadata: { mediaType: 'image/png' }, extensions: { fileSize: 2048 }, _links: { download: '/download/attachments/42/flow.png' } }] } },
      body: { view: { value: '<h2>Goal</h2><p>Ship <strong>it</strong></p>' } },
    },
  });
  const read = await call('get_page', { page: `${confluence.url}/pages/viewpage.action?pageId=42` });
  assert.equal(
    read.text,
    [
      '# Spec', '', '- **Page ID:** 42', '- **Space:** ENG — Engineering', '- **Breadcrumb:** Home › Specs',
      '- **Version:** 3 — last updated 2026-10-01 by Ana', `- **URL:** ${confluence.url}/spaces/ENG/pages/42/Spec`,
      '- **Attachments (1):**', `  - flow.png (image/png, 2 KB, id 501) — ${confluence.url}/download/attachments/42/flow.png`,
      '', '---', '', '## Goal', '', 'Ship **it**', '',
    ].join('\n'),
  );
  assert.equal(confluence.seen[0]?.url, '/rest/api/content/42?expand=body.view,version,space,ancestors,children.attachment,metadata.labels');

  await call('get_page', { page: '42', version: 2 });
  assert.equal(confluence.seen[1]?.url, '/rest/api/content/42?expand=body.view,version,space,ancestors,children.attachment,metadata.labels&status=historical&version=2');
});

test('get_page: an empty view falls back to storage, which stays unconverted', async () => {
  routes = (seen) => ({ body: seen.url.includes('body.view') ? page('') : { body: { storage: { value: '<p>raw</p>' } } } });
  const read = await call('get_page', { page: '42' });
  assert.match(read.text, /- \*\*Note:\*\* `view` body was empty; showed the other format instead\.\n\n---\n\n<p>raw<\/p>$/);
});

test('a title resolves to one page, and two pages with that title are refused', async () => {
  routes = (seen) => (seen.url.startsWith('/rest/api/content?') ? { body: { results: [{ id: '42' }] } } : { body: page('<p>x</p>') });
  await call('get_page', { page: 'Checkout spec' });
  await call('get_page', { page: `${confluence.url}/display/ENG/Checkout+spec` });
  assert.deepEqual(
    titleLookups().map((q) => [q.get('title'), q.get('spaceKey')]),
    [['Checkout spec', null], ['Checkout spec', 'ENG']],
  );

  routes = () => ({ body: { results: [{ id: '1', title: 'Spec', space: { key: 'A' } }, { id: '2', title: 'Spec', space: { key: 'B' } }] } });
  const ambiguous = await call('get_page', { page: 'Spec' });
  assert.ok(ambiguous.isError);
  assert.match(ambiguous.text, /more than one page is titled 'Spec':\n {2}1 {2}\[A\] {2}Spec\n {2}2 {2}\[B\] {2}Spec/);

  routes = (seen) => (seen.url.startsWith('/rest/api/content?') ? { body: { results: [{ id: '1' }] } } : { body: page('<p>x</p>') });
  assert.match((await call('preview_section_update', { page: 'Spec', space: 'A', marker: 'r', content: '<p>y</p>' })).text, /^Would append 'r' to "Spec" \(1, /);
  assert.equal(titleLookups().at(-1)?.get('spaceKey'), 'A');
});

test('search_pages: quotes escaped in CQL, the footer paged, raw CQL passed as written', async () => {
  routes = () => ({ body: { totalSize: 21261, results: [{ id: '42', title: 'Spec', space: { key: 'ENG' }, _links: { webui: '/x/42' } }] } });
  const found = await call('search_pages', { text: 'say "hi"', space: 'ENG', limit: 3 });
  assert.equal(queryOf(confluence.seen, 0).get('cql'), 'type=page AND (title ~ "say \\"hi\\"" OR text ~ "say \\"hi\\"") AND space="ENG" ORDER BY lastmodified DESC');
  assert.equal(queryOf(confluence.seen, 0).get('limit'), '3');
  assert.equal(found.text, `42  [ENG]  Spec  —  ${confluence.url}/x/42\nshowing 1–1 of 21,261; pass start=1 for more`);

  routes = () => ({ body: { totalSize: 1, results: [{ id: '77', type: 'comment', title: 'Re: Spec', space: { key: 'ENG' }, _links: { webui: '/x/77' } }] } });
  const cql = await call('search_pages', { cql: 'label = "runbook" ORDER BY created DESC', start: 10 });
  assert.equal(queryOf(confluence.seen, 1).get('cql'), 'label = "runbook" ORDER BY created DESC');
  assert.equal(queryOf(confluence.seen, 1).get('start'), '10');
  assert.equal(cql.text, `77  [ENG]  (comment)  Re: Spec  —  ${confluence.url}/x/77\nshowing 11–11 of 1`);

  await call('search_pages', { text: 'x', type: 'attachment', title_only: true });
  assert.equal(queryOf(confluence.seen, 2).get('cql'), 'type=attachment AND title ~ "x" ORDER BY lastmodified DESC');
  assert.match((await call('search_pages', { cql: 'x', space: 'ENG' })).text, /put the space, type and title clauses inside the CQL/);
  assert.match((await call('search_pages', {})).text, /exactly one of `text` or `cql`/);
});

test('preview_section_update shows both sections and writes nothing', async () => {
  routes = () => ({ body: page('<p>intro</p><!-- report START -->\n<p>old</p>\n<!-- report END --><p>outro</p>') });
  const preview = await call('preview_section_update', { page: '42', marker: 'report', content: '<p>new</p>' });
  assert.equal(
    preview.text,
    [
      `Would update 'report' on "Spec" (42, v7 -> v8)`, '--- current section', '<!-- report START -->\n<p>old</p>\n<!-- report END -->',
      '+++ new section', '<!-- report START -->\n<p>new</p>\n<!-- report END -->', `${confluence.url}/spaces/ENG/pages/42/Spec`,
    ].join('\n'),
  );
  assert.ok(confluence.seen.every((s) => s.method === 'GET'));
});

test('update_section replaces only the marked section, or appends it, converting Markdown through Confluence', async () => {
  routes = (seen) => (seen.method === 'PUT' ? { body: {} } : { body: page('<p>intro</p><!-- r START -->\nold\n<!-- r END --><p>outro</p>') });
  assert.equal((await call('update_section', { page: '42', marker: 'r', content: 'new' })).text, `Updated 'r' on "Spec" (v7 -> v8) — ${confluence.url}/spaces/ENG/pages/42/Spec`);
  const written = JSON.parse(confluence.seen.at(-1)?.body ?? '');
  assert.equal(written.body.storage.value, '<p>intro</p><!-- r START -->\nnew\n<!-- r END --><p>outro</p>');
  assert.deepEqual(written.version, { number: 8, message: 'r (updated by agent)' });

  routes = (seen) =>
    seen.url.startsWith('/rest/api/contentbody/convert/storage') ? { body: { value: '<h2>Done</h2><p><strong>yes</strong></p>', representation: 'storage' } } : seen.method === 'PUT' ? { body: {} } : { body: page('<p>intro</p>') };
  confluence.seen.length = 0;
  assert.match((await call('update_section', { page: '42', marker: 'r', content: '## Done\n\n**yes**', format: 'markdown' })).text, /^Appended 'r'/);
  assert.deepEqual(JSON.parse(confluence.seen[1]?.body ?? ''), { value: 'h2. Done\n\n*yes*', representation: 'wiki' });
  assert.equal(JSON.parse(confluence.seen.at(-1)?.body ?? '').body.storage.value, '<p>intro</p>\n<!-- r START -->\n<h2>Done</h2><p><strong>yes</strong></p>\n<!-- r END -->');
});

test('update_section refuses the three unclear cases', async () => {
  routes = () => ({ body: page('<p>x</p><!-- r START --><p>y</p>') });
  assert.match((await call('update_section', { page: '42', marker: 'r', content: 'z' })).text, /only one of the two 'r' markers/);
  routes = () => ({ body: page('<h2>Verification — PROJ-1</h2><p>y</p>') });
  assert.match((await call('update_section', { page: '42', marker: 'r', heading: 'verification — proj-1', content: 'z' })).text, /markers were probably stripped/);
  assert.ok(confluence.seen.every((s) => s.method === 'GET'), 'nothing was written');
  routes = (seen) => (seen.method === 'PUT' ? { status: 409 } : { body: page('') });
  assert.match((await call('update_section', { page: '42', marker: 'r', content: 'z' })).text, /HTTP 409 — it changed since it was read/);
});

test('get_attachment: relative URLs resolve on the host, other hosts are refused', async () => {
  routes = () => ({ headers: { 'content-type': 'text/plain' }, body: 'notes' });
  assert.equal((await call('get_attachment', { url: '/download/attachments/42/notes%20v2.txt?version=1' })).text, 'notes v2.txt (text/plain, 5 B)\n\nnotes');
  assert.equal(confluence.seen[0]?.authorization, 'Bearer test-token');
  assert.match((await call('get_attachment', { url: `${elsewhere.url}/download/x.png` })).text, /refusing to send CONFLUENCE_PERSONAL_TOKEN/);
  assert.equal(elsewhere.seen.length, 0);
});

test('converter: tables, nested lists, code macros, entities and macro placeholders', () => {
  assert.equal(
    htmlToMarkdown('<table><tr><th>A</th><th>B|C</th></tr><tr><td>1<br/>2</td><td></td></tr></table>'),
    '| A | B\\|C |\n| --- | --- |\n| 1 2 | |\n',
  );
  assert.equal(htmlToMarkdown('<ol><li>one<ul><li>inner</li></ul></li><li>two</li></ol>'), '1. one\n  - inner\n2. two\n');
  assert.equal(
    htmlToMarkdown('<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[if (a < b) {\n  go();\n}]]></ac:plain-text-body></ac:structured-macro>'),
    '```\nif (a < b) {\n  go();\n}\n```\n',
  );
  assert.equal(htmlToMarkdown('<blockquote><p>one</p></blockquote><p>a&nbsp;&amp;&rsquo;&#x41;&#66;&unknown;</p>'), '> one\n\na &’AB&unknown;\n');
  assert.equal(htmlToMarkdown('<p>PROJ-1 - Getting issue details... STATUS</p><script>x = "<p>"</script>'), 'PROJ-1\n');
});
