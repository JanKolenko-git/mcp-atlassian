// Confluence HTML to Markdown, for both bodies the REST API returns: the rendered `view` HTML,
// macros expanded, and the raw `storage` XHTML with its `ac:` and `ri:` elements.

// Stands in for list indentation so the whitespace cleanup can't eat it.
const INDENT = '\u0000';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'head']);
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'dl', 'dd', 'dt']);
const PANEL_MACROS = new Set(['info', 'note', 'warning', 'tip', 'panel']);
const headingLevel = (tag: string) => (/^h[1-6]$/.test(tag) ? Number(tag[1]) : 0);

// Named references by code point: ISO 8859-1 from 160, then the others Confluence writes.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para ' +
  'middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute ' +
  'Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute ' +
  'THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ' +
  'ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const ENTITIES = new Map<string, number>([
  ...LATIN1.split(' ').map((name, offset): [string, number] => [name, 160 + offset]),
  ...Object.entries({
    quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, Ccaron: 268,
    ccaron: 269, Zcaron: 381, zcaron: 382, fnof: 402, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204,
    zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
    bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249,
    rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, lArr: 8656, rArr: 8658,
    hArr: 8660, minus: 8722, infin: 8734, asymp: 8776, ne: 8800, le: 8804, ge: 8805, check: 10003, cross: 10007,
  }),
]);

function decode(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    const hex = /^#[xX]/.test(ref);
    const code = ref.startsWith('#') ? Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10) : ENTITIES.get(ref);
    if (code === undefined) return whole;
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  });
}

type Attrs = Map<string, string | null>;
type Token = { kind: 'start'; tag: string; attrs: Attrs } | { kind: 'end'; tag: string } | { kind: 'text' | 'cdata'; text: string };

function parseAttrs(source: string): Attrs {
  const attrs: Attrs = new Map();
  for (const match of source.matchAll(/([^\s/>=][^\s/>=]*)(?:\s*=+\s*("[^"]*"|'[^']*'|[^>\s]*))?/g)) {
    const raw = match[2];
    const value = raw === undefined ? null : /^["']/.test(raw) ? raw.slice(1, -1) : raw;
    attrs.set((match[1] ?? '').toLowerCase(), value === null ? null : decode(value));
  }
  return attrs;
}

/** The closing `>` of a tag opened at `from`, skipping any inside a quoted attribute value. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  let previous = '';
  for (let at = from; at < html.length; at++) {
    const char = html[at] ?? '';
    if (quote) {
      if (char === quote) [quote, previous] = ['', char];
      continue;
    }
    if (char === '>') return at;
    // A quote opens a value only right after `=`, as in an attribute.
    if ((char === '"' || char === "'") && previous === '=') quote = char;
    if (!/\s/.test(char)) previous = char;
  }
  return -1;
}

/**
 * Tokens the way Python's html.parser reports them: text decoded and flushed at every piece of
 * markup, tag and attribute names lowercased, a self-closing tag as a start and an end.
 */
function* tokenize(html: string): Generator<Token> {
  let text = '';
  let at = 0;
  const flush = function* (): Generator<Token> {
    if (text) yield { kind: 'text', text: decode(text) };
    text = '';
  };
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) {
      text += html.slice(at);
      break;
    }
    text += html.slice(at, open);
    const rest = html.slice(open, open + 9);
    let close: number;
    if (rest.startsWith('<!--')) {
      yield* flush();
      close = html.indexOf('-->', open + 4);
      at = close === -1 ? html.length : close + 3;
    } else if (rest === '<![CDATA[') {
      yield* flush();
      close = html.indexOf(']]>', open + 9);
      yield { kind: 'cdata', text: html.slice(open + 9, close === -1 ? html.length : close) };
      at = close === -1 ? html.length : close + 3;
    } else if (/^<[!?]/.test(rest) || /^<\/[A-Za-z]/.test(rest)) {
      yield* flush();
      close = html.indexOf('>', open);
      if (rest[1] === '/') yield { kind: 'end', tag: (/^<\/([^\s/>]+)/.exec(html.slice(open, open + 200))?.[1] ?? '').toLowerCase() };
      at = close === -1 ? html.length : close + 1;
    } else if (/^<[A-Za-z]/.test(rest) && (close = tagEnd(html, open)) !== -1) {
      yield* flush();
      const inner = html.slice(open + 1, close);
      const tag = (/^[^\s/>]+/.exec(inner)?.[0] ?? '').toLowerCase();
      yield { kind: 'start', tag, attrs: parseAttrs(inner.slice(tag.length)) };
      at = close + 1;
      if (inner.endsWith('/')) yield { kind: 'end', tag };
      else if (tag === 'script' || tag === 'style') {
        // Raw text, not markup: skip to the matching end tag.
        const end = new RegExp(`</${tag}`, 'gi');
        end.lastIndex = at;
        at = end.exec(html)?.index ?? html.length;
      }
    } else {
      text += '<';
      at = open + 1;
    }
  }
  yield* flush();
}

function flattenCell(text: string): string {
  // Markdown table cells are single-line, so collapse and escape pipes.
  return text.replaceAll(INDENT, ' ').replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
}

function renderTable(rows: string[][]): string {
  const kept = rows.filter((row) => row.some((cell) => cell.trim()));
  if (!kept.length) return '';
  const width = Math.max(...kept.map((row) => row.length));
  const line = (row: string[]) => `| ${[...row, ...Array<string>(width - row.length).fill('')].join(' | ')} |`;
  return [line(kept[0] ?? []), line(Array<string>(width).fill('---')), ...kept.slice(1).map(line)].join('\n');
}

/**
 * Drops placeholder text left by macros that resolve client-side. The Jira-issue macro ships
 * "Getting issue details... STATUS", which reads as if the ticket's status were "STATUS".
 */
const stripMacroPlaceholders = (text: string) => text.replace(/\s*-?\s*Getting issue details\.\.\.\s*STATUS/g, '');

function cleanup(text: string): string {
  // Whitespace is normalised everywhere except inside fenced code blocks.
  const parts = text.split('```').map((part, index) => {
    if (index % 2) return part;
    const spaced = part.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
    return stripMacroPlaceholders(spaced).replace(/\n{3,}/g, '\n\n');
  });
  const lines = parts.join('```').replaceAll(INDENT, ' ').split('\n').map((line) => line.trimEnd());
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

interface Table {
  rows: string[][];
  row: string[];
  cell: string[] | null;
}

class Converter {
  out: string[] = [];
  skipDepth = 0;
  preDepth = 0;
  lists: { kind: string; count: number }[] = [];
  tables: Table[] = [];
  links: (string | null)[] = [];
  // Where each open blockquote starts in `out`, so `>` can prefix every line once its content is known.
  quotes: number[] = [];
  freshListItem = false;

  emit(text: string): void {
    if (this.skipDepth || !text) return;
    const cell = this.tables.at(-1)?.cell;
    if (cell) cell.push(text);
    else this.out.push(text);
  }

  /** A paragraph break, unless a list item just opened. */
  block(): void {
    if (!this.freshListItem) this.emit('\n\n');
  }

  start(tag: string, attrs: Attrs): void {
    if (SKIP_TAGS.has(tag)) {
      this.skipDepth++;
      return;
    }
    if (this.skipDepth) return;
    const table = this.tables.at(-1);
    if (tag === 'br') this.emit('\n');
    else if (headingLevel(tag)) {
      this.block();
      this.emit(`${'#'.repeat(headingLevel(tag))} `);
    } else if (BLOCK_TAGS.has(tag)) this.block();
    else if (tag === 'hr') {
      this.block();
      this.emit('---');
      this.block();
    } else if (tag === 'ul' || tag === 'ol') {
      if (!this.lists.length) this.block();
      this.lists.push({ kind: tag, count: 0 });
    } else if (tag === 'li') {
      const list = this.lists.at(-1);
      if (list) list.count++;
      const marker = list?.kind === 'ol' ? `${list.count}. ` : '- ';
      this.emit(`\n${INDENT.repeat(Math.max(0, this.lists.length - 1) * 2)}${marker}`);
      this.freshListItem = true;
    } else if (tag === 'a') {
      const href = attrs.get('href') ?? null;
      this.links.push(href);
      if (href) this.emit('[');
    } else if (tag === 'strong' || tag === 'b') this.emit('**');
    else if (tag === 'em' || tag === 'i' || tag === 'cite') this.emit('*');
    else if (tag === 'del' || tag === 's' || tag === 'strike') this.emit('~~');
    else if (tag === 'code' && !this.preDepth) this.emit('`');
    else if (tag === 'pre' || tag === 'ac:plain-text-body') {
      this.block();
      this.emit('```\n');
      this.preDepth++;
    } else if (tag === 'blockquote') {
      this.block();
      this.quotes.push(this.out.length);
    } else if (tag === 'table') {
      this.block();
      this.tables.push({ rows: [], row: [], cell: null });
    } else if (tag === 'tr') {
      if (table) table.row = [];
    } else if (tag === 'td' || tag === 'th') {
      if (table) table.cell = [];
    } else if (tag === 'img') this.emit(`![${attrs.get('alt') || 'image'}](${attrs.get('src') ?? ''})`);
    else if (tag === 'ri:attachment') {
      const name = attrs.get('ri:filename');
      if (name) this.emit(`![attachment](${name})`);
    } else if (tag === 'ri:page') {
      const title = attrs.get('ri:content-title');
      if (title) this.emit(`[${title}]`);
    } else if (tag === 'ac:structured-macro') {
      const name = attrs.get('ac:name') ?? '';
      if (PANEL_MACROS.has(name)) {
        this.block();
        this.emit(`> **${name.toUpperCase()}** `);
      }
    }
  }

  end(tag: string): void {
    if (SKIP_TAGS.has(tag)) {
      this.skipDepth = Math.max(0, this.skipDepth - 1);
      return;
    }
    if (this.skipDepth) return;
    const table = this.tables.at(-1);
    if (headingLevel(tag) || BLOCK_TAGS.has(tag)) this.block();
    else if (tag === 'ul' || tag === 'ol') {
      this.lists.pop();
      if (!this.lists.length) this.block();
    } else if (tag === 'li') this.freshListItem = false;
    else if (tag === 'a') {
      const href = this.links.pop();
      if (href) this.emit(`](${href})`);
    } else if (tag === 'strong' || tag === 'b') this.emit('**');
    else if (tag === 'em' || tag === 'i' || tag === 'cite') this.emit('*');
    else if (tag === 'del' || tag === 's' || tag === 'strike') this.emit('~~');
    else if (tag === 'code' && !this.preDepth) this.emit('`');
    else if (tag === 'pre' || tag === 'ac:plain-text-body') {
      this.preDepth = Math.max(0, this.preDepth - 1);
      this.emit('\n```');
      this.block();
    } else if (tag === 'blockquote') {
      const start = this.quotes.pop();
      if (start !== undefined && !table?.cell) {
        const inner = stripMacroPlaceholders(this.out.splice(start).join('')).trim();
        if (inner) this.out.push(inner.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'));
      }
      this.block();
    } else if (tag === 'td' || tag === 'th') {
      if (table?.cell) {
        table.row.push(flattenCell(table.cell.join('')));
        table.cell = null;
      }
    } else if (tag === 'tr') {
      if (table) {
        if (table.row.length) table.rows.push(table.row);
        table.row = [];
      }
    } else if (tag === 'table') {
      const done = this.tables.pop();
      if (done) {
        this.emit(renderTable(done.rows));
        this.block();
      }
    }
  }

  text(data: string): void {
    if (this.skipDepth || !data) return;
    if (this.preDepth) {
      this.emit(data);
      return;
    }
    const collapsed = data.replace(/\s+/g, ' ');
    if (!collapsed.trim()) {
      this.emit(' ');
      return;
    }
    this.emit(collapsed);
    this.freshListItem = false;
  }
}

export function htmlToMarkdown(html: string): string {
  const converter = new Converter();
  for (const token of tokenize(html)) {
    if (token.kind === 'start') converter.start(token.tag, token.attrs);
    else if (token.kind === 'end') converter.end(token.tag);
    else if (token.kind === 'text') converter.text(token.text);
    else converter.emit(token.text);
  }
  return cleanup(converter.out.join(''));
}
