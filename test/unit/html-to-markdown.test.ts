import { describe, it } from 'node:test';
import assert from 'node:assert';
import { htmlToMarkdown, decodeEntities } from '../../src/core/web/html-to-markdown.js';

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    assert.strictEqual(decodeEntities('a &amp; b &lt; c &gt; d'), 'a & b < c > d');
  });
  it('decodes &nbsp; and &quot;', () => {
    assert.strictEqual(decodeEntities('he said &quot;hi&quot;&nbsp;there'), 'he said "hi" there');
  });
  it('decodes &apos;', () => {
    assert.strictEqual(decodeEntities('it&apos;s fine'), "it's fine");
  });
  it('decodes decimal numeric entities', () => {
    assert.strictEqual(decodeEntities('&#39;'), "'");
    assert.strictEqual(decodeEntities('&#65;&#66;'), 'AB');
  });
  it('decodes hex numeric entities', () => {
    assert.strictEqual(decodeEntities('&#x41;&#x42;'), 'AB');
    assert.strictEqual(decodeEntities('&#x2014;'), '—'); // em dash
  });
  it('preserves unknown entities verbatim', () => {
    assert.strictEqual(decodeEntities('&fakeent;'), '&fakeent;');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headers h1-h6', () => {
    const md = htmlToMarkdown('<h1>One</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>');
    assert.match(md, /# One/);
    assert.match(md, /## Two/);
    assert.match(md, /### Three/);
    assert.match(md, /###### Six/);
  });

  it('converts paragraphs to blank-line-separated text', () => {
    const md = htmlToMarkdown('<p>Hello.</p><p>World.</p>');
    assert.match(md, /Hello\.\n\nWorld\./);
  });

  it('converts <a href> to markdown links', () => {
    const md = htmlToMarkdown('<p>See <a href="https://example.com">example</a>.</p>');
    assert.match(md, /\[example\]\(https:\/\/example\.com\)/);
  });

  it('converts <code> inline and <pre> as fenced block', () => {
    const md = htmlToMarkdown('<p>Use <code>foo()</code>.</p><pre>code\n  block</pre>');
    assert.match(md, /`foo\(\)`/);
    assert.match(md, /```\ncode\n {2}block\n```/);
  });

  it('converts ul/li to dash bullets', () => {
    const md = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    assert.match(md, /- one/);
    assert.match(md, /- two/);
  });

  it('converts ol/li to numbered list', () => {
    const md = htmlToMarkdown('<ol><li>first</li><li>second</li></ol>');
    assert.match(md, /1\. first/);
    assert.match(md, /2\. second/);
  });

  it('converts strong/b to ** and em/i to *', () => {
    const md = htmlToMarkdown('<p><strong>bold</strong> and <em>italic</em> and <b>B</b> <i>I</i></p>');
    assert.match(md, /\*\*bold\*\*/);
    assert.match(md, /\*italic\*/);
    assert.match(md, /\*\*B\*\*/);
    assert.match(md, /\*I\*/);
  });

  it('renders <br> as newline', () => {
    const md = htmlToMarkdown('<p>line one<br>line two</p>');
    assert.match(md, /line one\nline two/);
  });

  it('renders simple table as pipe-separated rows', () => {
    const md = htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    assert.match(md, /\| A \| B \|/);
    assert.match(md, /\| 1 \| 2 \|/);
  });

  it('strips <script> and <style> blocks', () => {
    const md = htmlToMarkdown(
      '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>'
        + '<body><p>visible</p></body></html>',
    );
    assert.match(md, /visible/);
    assert.doesNotMatch(md, /alert/);
    assert.doesNotMatch(md, /color:red/);
  });

  it('strips nav/header/footer/aside/form/svg/iframe', () => {
    const md = htmlToMarkdown(
      '<body><nav>NAV</nav><header>HEAD</header><aside>SIDE</aside>'
        + '<form><input/></form><svg><circle/></svg><iframe src=x></iframe>'
        + '<p>keep</p><footer>FOOT</footer></body>',
    );
    assert.match(md, /keep/);
    for (const stripped of ['NAV', 'HEAD', 'SIDE', 'FOOT']) {
      assert.doesNotMatch(md, new RegExp(stripped));
    }
  });

  it('strips HTML comments', () => {
    const md = htmlToMarkdown('<p>before<!-- secret note --> after</p>');
    assert.match(md, /before after/);
    assert.doesNotMatch(md, /secret/);
  });

  it('prefers content inside <main> over <body>', () => {
    const md = htmlToMarkdown(
      '<body><p>outside</p><main><p>inside main</p></main><p>also outside</p></body>',
    );
    assert.match(md, /inside main/);
    assert.doesNotMatch(md, /outside/);
  });

  it('prefers <article> when no <main>', () => {
    const md = htmlToMarkdown(
      '<body><p>outside</p><article><p>inside article</p></article></body>',
    );
    assert.match(md, /inside article/);
    assert.doesNotMatch(md, /outside/);
  });

  it('falls back to <body> when no main/article', () => {
    const md = htmlToMarkdown('<body><p>body content</p></body>');
    assert.match(md, /body content/);
  });

  it('decodes entities in text content', () => {
    const md = htmlToMarkdown('<p>Tom &amp; Jerry &lt;3 &#39;quoted&#39;</p>');
    assert.match(md, /Tom & Jerry <3 'quoted'/);
  });

  it('collapses runs of blank lines to at most 2', () => {
    const md = htmlToMarkdown('<p>a</p><p></p><p></p><p></p><p>b</p>');
    // Should never have 3+ consecutive newlines.
    assert.doesNotMatch(md, /\n\n\n/);
    assert.match(md, /a/);
    assert.match(md, /b/);
  });
});
