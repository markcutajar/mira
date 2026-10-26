import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

// markdown.js is a plain browser script, so it runs here the way the board loads it.
const page: { renderMarkdown?: (text: string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), page);
const md = (text: string) => page.renderMarkdown?.(text) ?? '';

describe('renderMarkdown', () => {
  it('shows HTML in a reply as text, wherever it appears', () => {
    const html = md('<script>alert(1)</script>\n\n**<img src=x onerror=alert(1)>**\n\n`<b>`\n\n```\n<iframe>\n```\n\n| <svg> |\n|---|\n| <a> |');
    assert.doesNotMatch(html, /<(script|img|iframe|svg|b>|a>)/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('opens only http(s) links, and shows other links by name', () => {
    assert.equal(md('[docs](https://example.com/a_b_c?x=1&y=2)'), '<p><a href="https://example.com/a_b_c?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
    assert.equal(md('[run](javascript:alert(1))'), '<p><span class="md-ref" title="javascript:alert(1">run</span>)</p>');
    assert.equal(md('[server.ts:42](hub/src/server.ts#L42)'), '<p><span class="md-ref" title="hub/src/server.ts#L42">server.ts:42</span></p>');
    assert.equal(md('[x](https://e.com/" onmouseover="y)'), '<p>[x](https://e.com/&quot; onmouseover=&quot;y)</p>');
  });

  it('renders emphasis and code spans, but leaves snake_case and lone stars alone', () => {
    assert.equal(md('**bold**, *italic*, _also_, ~~gone~~ and `a_b * c`'), '<p><strong>bold</strong>, <em>italic</em>, <em>also</em>, <del>gone</del> and <code>a_b * c</code></p>');
    assert.equal(md('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
    assert.equal(md('**A link to `#session=<id>`** and [`x.ts`](src/x.ts)'), '<p><strong>A link to <code>#session=&lt;id&gt;</code></strong> and <span class="md-ref" title="src/x.ts"><code>x.ts</code></span></p>');
    assert.equal(md('`**not bold**` and \u00000\u0000'), '<p><code>**not bold**</code> and 0</p>');
  });

  it('keeps line breaks inside a paragraph', () => {
    assert.equal(md('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
  });

  it('renders headings below the panel title, rules, quotes and fenced code', () => {
    assert.equal(md('# Title\n## Part'), '<h3 class="md-h">Title</h3><h4 class="md-h">Part</h4>');
    assert.equal(md('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
    assert.equal(md('> quoted\n> **line**'), '<blockquote><p>quoted<br><strong>line</strong></p></blockquote>');
    assert.equal(md('```ts\nconst a = 1;\n  indented();\n```'), '<pre class="md-code"><code>const a = 1;\n  indented();</code></pre>');
  });

  it('renders tight, nested, numbered and task lists', () => {
    assert.equal(md('- one\n- two\n  - nested\n- three'), '<ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ul>');
    assert.equal(md('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>');
    assert.equal(md('1. step\n\n   more about it\n2. next'), '<ol><li>step<p>more about it</p></li><li>next</li></ol>');
    assert.equal(md('- [x] done\n- [ ] to do'), '<ul><li>☑ done</li><li>☐ to do</li></ul>');
    assert.equal(md('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('renders tables with alignment', () => {
    assert.equal(
      md('| Name | Cost |\n|:---|---:|\n| `hub` | $1 |\n| a \\| b |'),
      '<div class="md-table"><table><thead><tr><th>Name</th><th class="md-right">Cost</th></tr></thead><tbody><tr><td><code>hub</code></td><td class="md-right">$1</td></tr><tr><td>a | b</td><td class="md-right"></td></tr></tbody></table></div>',
    );
  });

  it('copes with nothing and with Windows line endings', () => {
    assert.equal(md(''), '');
    assert.equal(md('a\r\nb'), '<p>a<br>b</p>');
  });
});
