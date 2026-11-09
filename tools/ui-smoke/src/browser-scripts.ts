/**
 * Browser-side code, kept as plain JavaScript SOURCE STRINGS on purpose.
 *
 * Playwright serialises functions with `fn.toString()`. tsx / esbuild (keepNames) instruments functions with a
 * `__name(...)` helper that does not exist in the page, which breaks `page.evaluate(fn)` and
 * `addInitScript(fn)` with "ReferenceError: __name is not defined". Strings avoid the whole class of problems.
 *
 * Every script is an IIFE expression, so it works with `page.evaluate(string)` and with
 * `addInitScript({ content })`. The unit tests execute them inside a `node:vm` sandbox.
 */

/** Shifts `Date` so that "now" starts at `targetMs` and then keeps flowing (timers / rAF stay real). */
export function dateShiftScript(targetMs: number): string {
  return `(function () {
  try {
    var g = typeof window !== 'undefined' ? window : globalThis;
    var RealDate = g.Date;
    if (RealDate.__smokeShifted) return;
    var offset = ${JSON.stringify(targetMs)} - RealDate.now();
    function ShiftedDate(a, b, c, d, e, f, h) {
      if (!(this instanceof ShiftedDate)) return new RealDate(RealDate.now() + offset).toString();
      switch (arguments.length) {
        case 0: return new RealDate(RealDate.now() + offset);
        case 1: return new RealDate(a);
        case 2: return new RealDate(a, b);
        case 3: return new RealDate(a, b, c);
        case 4: return new RealDate(a, b, c, d);
        case 5: return new RealDate(a, b, c, d, e);
        case 6: return new RealDate(a, b, c, d, e, f);
        default: return new RealDate(a, b, c, d, e, f, h);
      }
    }
    ShiftedDate.now = function () { return RealDate.now() + offset; };
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    ShiftedDate.prototype = RealDate.prototype;
    ShiftedDate.__smokeShifted = true;
    g.Date = ShiftedDate;
  } catch (e) { /* never break the page */ }
})();`;
}

/**
 * Stores the supabase-js session in localStorage BEFORE the app scripts run (once per tab: a sessionStorage
 * flag prevents re-seeding after the app signed out and reloaded).
 */
export function seedSessionScript(opts: { origin: string; storageKey: string; session: unknown }): string {
  return `(function () {
  try {
    if (location.origin !== ${JSON.stringify(opts.origin)}) return;
    if (window.sessionStorage.getItem('__smoke_seeded') === '1') return;
    window.sessionStorage.setItem('__smoke_seeded', '1');
    window.localStorage.setItem(${JSON.stringify(opts.storageKey)}, ${JSON.stringify(JSON.stringify(opts.session))});
  } catch (e) { /* storage unavailable */ }
})();`;
}

/** Text that signals a broken screen (fatal) or a suspicious one (warning). Sources of JS regular expressions. */
export const FATAL_TEXT_PATTERNS: readonly string[] = [
  'Unmatched Route',
  "This screen doesn't exist",
  'Page could not be found',
  'Uncaught (?:Error|TypeError|ReferenceError|RangeError)',
  'Render Error',
  'Application error',
  'Minified React error',
  'Maximum update depth exceeded',
  'Error: Element type is invalid',
];

export const SUSPECT_TEXT_PATTERNS: readonly string[] = [
  'Something went wrong',
  'Could not load',
  'Failed to fetch',
  'Network request failed',
  'TypeError: ',
  'ReferenceError: ',
  'undefined is not',
  'Cannot read propert',
  '\\[object Object\\]',
  '\\bNaN\\b',
  '\\bundefined\\b',
];

/** Reads what the user sees: visible text, error-looking text, document metrics. */
export function inspectPageScript(): string {
  return `(function () {
  var fatal = ${JSON.stringify(FATAL_TEXT_PATTERNS)};
  var suspect = ${JSON.stringify(SUSPECT_TEXT_PATTERNS)};
  var body = document.body;
  var raw = body ? (body.innerText || '') : '';
  var text = raw.replace(/\\s+/g, ' ').trim();
  function hits(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = new RegExp(list[i]).exec(text);
      if (m) out.push(m[0]);
    }
    return out;
  }
  var root = document.getElementById('root');
  return {
    url: location.href,
    title: document.title,
    textLength: text.length,
    sample: text.slice(0, 300),
    fatalHits: hits(fatal),
    suspectHits: hits(suspect),
    hasRoot: !!root,
    rootChildren: root ? root.children.length : 0,
    inputs: document.querySelectorAll('input,textarea').length,
    buttons: document.querySelectorAll('[role="button"],button').length
  };
})()`;
}

/** Largest amount of content that is scrolled away inside any scroll container (or the document). */
export function scrollMetricsScript(): string {
  return `(function () {
  var best = 0;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight - el.clientHeight > best) best = el.scrollHeight - el.clientHeight;
  }
  var doc = document.documentElement;
  var docExtra = doc ? doc.scrollHeight - window.innerHeight : 0;
  return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, extra: Math.max(best, docExtra, 0) };
})()`;
}

/** Scrolls the largest scroll container (or the window) by `px`. Returns the new scrollTop. */
export function scrollMainScript(px: number): string {
  return `(function () {
  var target = null, best = 0;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var oy = getComputedStyle(el).overflowY;
    var extra = el.scrollHeight - el.clientHeight;
    if ((oy === 'auto' || oy === 'scroll') && extra > best) { best = extra; target = el; }
  }
  if (target) { target.scrollTop = target.scrollTop + ${JSON.stringify(px)}; return target.scrollTop; }
  window.scrollBy(0, ${JSON.stringify(px)});
  return window.scrollY;
})()`;
}
