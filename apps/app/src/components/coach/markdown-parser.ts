/**
 * A tiny, safe markdown subset for coach replies. Pure (no React): the parser only produces text spans, and the
 * renderer only ever puts those strings into <Text>, so there is no HTML, no links and no images to inject.
 *
 * Supported: **bold** (also __bold__), *italic* / _italic_, `code`, "- " / "* " / bullet-dot lists, "1." / "1)"
 * numbered lists (one nesting level per two spaces of indent), "#" headings (rendered as bold lines), "---" rules,
 * blank-line separated paragraphs and single line breaks. Anything unclosed stays literal text.
 */

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface MdListItem {
  /** 0..3 */
  level: number;
  /** "\u2022", "\u2013" or "3." (the number the author typed) */
  marker: string;
  spans: MdSpan[];
}

export type MdBlock =
  | { type: 'paragraph'; lines: MdSpan[][] }
  | { type: 'heading'; spans: MdSpan[] }
  | { type: 'list'; items: MdListItem[] }
  | { type: 'rule' };

interface Style {
  bold?: boolean;
  italic?: boolean;
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function parseInto(src: string, base: Style, partial: boolean, out: MdSpan[]): void {
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ text: buf, ...base });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;

    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ text: src.slice(i + 1, end), ...base, code: true });
        i = end + 1;
        continue;
      }
    }

    const pair = src.slice(i, i + 2);
    if (pair === '**' || pair === '__') {
      // "__" only opens at a word boundary so snake__case stays literal
      const opens = pair === '**' || !isWordChar(src[i - 1]);
      if (opens && !isSpace(src[i + 2])) {
        const end = src.indexOf(pair, i + 2);
        if (end > i + 2) {
          flush();
          parseInto(src.slice(i + 2, end), { ...base, bold: true }, false, out);
          i = end + 2;
          continue;
        }
        if (end === -1 && partial && pair === '**') {
          // still streaming: show the text bold right away instead of flashing literal asterisks
          flush();
          parseInto(src.slice(i + 2), { ...base, bold: true }, true, out);
          return;
        }
      }
    } else if (ch === '*' || ch === '_') {
      const opens = ch === '*' || !isWordChar(src[i - 1]);
      if (opens && !isSpace(src[i + 1]) && src[i + 1] !== ch) {
        let end = src.indexOf(ch, i + 1);
        while (end !== -1) {
          const closes =
            !isSpace(src[end - 1]) &&
            src[end + 1] !== ch &&
            src[end - 1] !== ch &&
            (ch === '*' || !isWordChar(src[end + 1]));
          if (closes) break;
          end = src.indexOf(ch, end + 1);
        }
        if (end > i + 1) {
          flush();
          parseInto(src.slice(i + 1, end), { ...base, italic: true }, false, out);
          i = end + 1;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
}

/** Inline spans of one line / paragraph. `partial` renders an unclosed leading "**" as bold (streaming). */
export function parseInline(src: string, partial = false): MdSpan[] {
  const out: MdSpan[] = [];
  parseInto(src, {}, partial, out);
  return out;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+\u2022\u25E6\u2043]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

const levelOf = (indent: string): number => Math.min(3, Math.floor(indent.replace(/\t/g, '    ').length / 2));

/** Parses text into blocks. Never throws; unknown syntax is kept as plain paragraph text. */
export function parseMarkdown(text: string, opts: { partial?: boolean } = {}): MdBlock[] {
  const partial = opts.partial ?? false;
  const blocks: MdBlock[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: MdListItem[] | null = null;
  let listRaw: string[] = []; // raw text per item, so continuation lines can be appended before spans are built

  // `tail` = this block is the end of the text, i.e. the part that may still be growing while streaming
  const closeParagraph = (tail: boolean): void => {
    if (paragraph.length) {
      const last = paragraph.length - 1;
      blocks.push({ type: 'paragraph', lines: paragraph.map((l, i) => parseInline(l, partial && tail && i === last)) });
      paragraph = [];
    }
  };
  const closeList = (tail: boolean): void => {
    if (list) {
      const items: MdListItem[] = list;
      items.forEach((item, i) => {
        item.spans = parseInline(listRaw[i] ?? '', partial && tail && i === items.length - 1);
      });
      blocks.push({ type: 'list', items });
      list = null;
      listRaw = [];
    }
  };

  lines.forEach((raw, index) => {
    const isLast = index === lines.length - 1;
    const line = raw.replace(/\s+$/, '');

    if (line.trim() === '') {
      closeParagraph(false);
      closeList(false);
      return;
    }
    if (RULE.test(line)) {
      closeParagraph(false);
      closeList(false);
      blocks.push({ type: 'rule' });
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph(false);
      closeList(false);
      blocks.push({ type: 'heading', spans: parseInline(heading[1] ?? '', partial && isLast).map((s) => ({ ...s, bold: true })) });
      return;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      closeParagraph(false);
      if (!list) list = [];
      const level = levelOf((bullet ? bullet[1] : ordered?.[1]) ?? '');
      list.push({
        level,
        marker: bullet ? (level === 0 ? '\u2022' : '\u2013') : `${ordered?.[2] ?? ''}.`,
        spans: [],
      });
      listRaw.push((bullet ? bullet[2] : ordered?.[3]) ?? '');
      return;
    }
    if (list && /^\s+/.test(raw)) {
      // indented continuation of the previous list item
      listRaw[listRaw.length - 1] = `${listRaw[listRaw.length - 1] ?? ''} ${line.trim()}`;
      return;
    }
    closeList(false);
    paragraph.push(line.trim());
  });
  closeParagraph(true);
  closeList(true);
  return blocks;
}
