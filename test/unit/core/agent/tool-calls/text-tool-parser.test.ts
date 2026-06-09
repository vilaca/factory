import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseTextToolCalls } from '../../../../../src/core/agent/tool-calls/text-tool-parser.js';
import { normalizeToolArguments } from '../../../../../src/utils/tool-call-args.js';

const argsOf = (tc: { function: { arguments: unknown } }) =>
  normalizeToolArguments(tc.function.arguments);

describe('parseTextToolCalls', () => {
  it('returns no calls and original content when no tags present', () => {
    const result = parseTextToolCalls('hello world');
    assert.strictEqual(result.toolCalls.length, 0);
    assert.strictEqual(result.cleanedContent, 'hello world');
    assert.strictEqual(result.malformedCount, 0);
  });

  it('extracts a single well-formed tool call', () => {
    const content =
      'Let me read the file.\n<tool_call>{"name": "Read", "arguments": {"file_path": "/foo"}}</tool_call>';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'Read');
    assert.deepStrictEqual(result.toolCalls[0].function.arguments, { file_path: '/foo' });
    assert.strictEqual(result.cleanedContent, 'Let me read the file.');
    assert.strictEqual(result.malformedCount, 0);
  });

  it('extracts multiple sequential tool calls', () => {
    const content =
      '<tool_call>{"name": "Read", "arguments": {"file_path": "/a"}}</tool_call>\n' +
      '<tool_call>{"name": "Read", "arguments": {"file_path": "/b"}}</tool_call>';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 2);
    assert.strictEqual(argsOf(result.toolCalls[0]).file_path, '/a');
    assert.strictEqual(argsOf(result.toolCalls[1]).file_path, '/b');
    assert.strictEqual(result.malformedCount, 0);
  });

  it('treats malformed JSON as malformed and removes the tag', () => {
    const content = 'before\n<tool_call>{not valid json}</tool_call>\nafter';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 0);
    assert.strictEqual(result.malformedCount, 1);
    assert.match(result.cleanedContent, /before/);
    assert.match(result.cleanedContent, /after/);
    assert.doesNotMatch(result.cleanedContent, /<tool_call>/);
  });

  it('treats JSON without "name" string as malformed', () => {
    const content = '<tool_call>{"arguments": {"x": 1}}</tool_call>';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 0);
    assert.strictEqual(result.malformedCount, 1);
  });

  it('uses empty arguments object when arguments field missing', () => {
    const content = '<tool_call>{"name": "Glob"}</tool_call>';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.deepStrictEqual(result.toolCalls[0].function.arguments, {});
  });

  it('extracts a tool call from a bare-JSON-only message', () => {
    const content = '{"name": "Read", "arguments": {"file_path": "/foo"}}';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'Read');
    assert.deepStrictEqual(result.sources, ['bare']);
    assert.strictEqual(result.cleanedContent, '');
  });

  it('extracts multiple bare-JSON tool calls separated by blank lines', () => {
    const content = `{
  "name": "Bash",
  "arguments": { "command": "npm install eslint" }
}

{
  "name": "Glob",
  "arguments": { "pattern": "src/**/*.ts" }
}`;
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 2);
    assert.strictEqual(result.toolCalls[0].function.name, 'Bash');
    assert.strictEqual(result.toolCalls[1].function.name, 'Glob');
    assert.deepStrictEqual(result.sources, ['bare', 'bare']);
    assert.strictEqual(result.cleanedContent, '');
  });

  it('recovers a Bash tool call from a ```bash fence when nothing else matched', () => {
    const content = '```bash\nnpm install eslint --save-dev\n```';
    const result = parseTextToolCalls(content, new Set(['Bash', 'Read', 'Edit']));
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'Bash');
    const args = argsOf(result.toolCalls[0]);
    assert.strictEqual(args.command, 'npm install eslint --save-dev');
    assert.deepStrictEqual(result.sources, ['shell-fence']);
  });

  it('preserves multiline shell commands with backslash continuations', () => {
    const content =
      '```bash\nnpx eslint --init \\\n  --module-type commonjs \\\n  --typescript false\n```';
    const result = parseTextToolCalls(content, new Set(['Bash']));
    assert.strictEqual(result.toolCalls.length, 1);
    const args = argsOf(result.toolCalls[0]);
    assert.match(args.command as string, /--module-type commonjs/);
    assert.match(args.command as string, /--typescript false/);
  });

  it('does NOT use shell-fence fallback when prose surrounds the fence', () => {
    const content = 'You can run this:\n```bash\nls\n```\nIt will list files.';
    const result = parseTextToolCalls(content, new Set(['Bash']));
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('skips shell-fence fallback when a structured tool call already matched', () => {
    const content =
      '<tool_call>{"name":"Read","arguments":{"file_path":"/x"}}</tool_call>\n```bash\nrm -rf /\n```';
    const result = parseTextToolCalls(content, new Set(['Bash', 'Read']));
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'Read');
  });

  it('tolerates a stray closing brace from a model typo', () => {
    // Model emitted one too many "}" after the second object — common qwen typo.
    const content =
      `{"name": "Write", "arguments": {"file_path": "/x", "content": "y"}}\n` +
      `{"name": "Edit", "arguments": {"file_path": "/y", "old_string": "a", "new_string": "b"}}}\n` +
      `{"name": "Glob", "arguments": {"pattern": "*.ts"}}`;
    const result = parseTextToolCalls(content, new Set(['Write', 'Edit', 'Glob']));
    assert.strictEqual(result.toolCalls.length, 3);
    assert.deepStrictEqual(
      result.toolCalls.map(tc => tc.function.name),
      ['Write', 'Edit', 'Glob'],
    );
  });

  it('rejects parsed calls whose name is not a known tool', () => {
    const content = '<tool_call>{"name": "factory", "arguments": {}}</tool_call>';
    const result = parseTextToolCalls(content, new Set(['Read', 'Edit', 'Write']));
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('accepts parsed calls when name is in the known set', () => {
    const content = '<tool_call>{"name": "Read", "arguments": {"file_path": "/x"}}</tool_call>';
    const result = parseTextToolCalls(content, new Set(['Read', 'Edit', 'Write']));
    assert.strictEqual(result.toolCalls.length, 1);
  });

  it('refuses multi-bare-JSON when prose is mixed in', () => {
    const content = `Here is what I will do:

{ "name": "Bash", "arguments": { "command": "ls" } }

Now I will run another:

{ "name": "Read", "arguments": { "file_path": "/x" } }`;
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('does NOT treat bare JSON as tool call when wrapped in prose', () => {
    const content = 'Here is an example: {"name": "Read", "arguments": {}}';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('extracts tool call from a JSON code fence', () => {
    const content =
      'I will read the file:\n```json\n{"name": "Read", "arguments": {"file_path": "/bar"}}\n```';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(argsOf(result.toolCalls[0]).file_path, '/bar');
    assert.deepStrictEqual(result.sources, ['fence']);
    assert.match(result.cleanedContent, /I will read the file/);
  });

  it('keeps non-tool-call code blocks untouched', () => {
    const content = 'Example output:\n```\nfoo bar\n```';
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 0);
    assert.match(result.cleanedContent, /foo bar/);
  });

  it('handles multiline JSON inside the tag', () => {
    const content = `<tool_call>
{
  "name": "Bash",
  "arguments": {
    "command": "ls -la"
  }
}
</tool_call>`;
    const result = parseTextToolCalls(content);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'Bash');
    assert.strictEqual(argsOf(result.toolCalls[0]).command, 'ls -la');
  });

  // Case-insensitive matching. Small models routinely lowercase tool names
  // ("read" instead of "Read"). The registry's get() is case-insensitive and
  // the validator's unknown-tool check is too — the parser was previously
  // stricter than both and silently dropped lowercase calls before either
  // could see them. These tests pin the canonicalization contract.
  describe('case-insensitive tool name matching', () => {
    it('accepts a lowercase name in a <tool_call> tag and canonicalizes to the registered name', () => {
      const result = parseTextToolCalls(
        '<tool_call>{"name":"read","arguments":{"file_path":"/x"}}</tool_call>',
        new Set(['Read']),
      );
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Read');
      assert.strictEqual(result.malformedCount, 0);
    });

    it('accepts an UPPERCASE name and canonicalizes', () => {
      const result = parseTextToolCalls(
        '<tool_call>{"name":"BASH","arguments":{"command":"ls"}}</tool_call>',
        new Set(['Bash']),
      );
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Bash');
    });

    it('accepts a lowercase name in a bare-JSON fallback', () => {
      const result = parseTextToolCalls(
        '{"name":"read","arguments":{"file_path":"/x"}}',
        new Set(['Read']),
      );
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Read');
    });

    it('accepts a lowercase name in a Hermes-style <function=...> tag', () => {
      const result = parseTextToolCalls(
        '<function=read><parameter=file_path>/x</parameter></function>',
        new Set(['Read']),
      );
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Read');
      assert.strictEqual(argsOf(result.toolCalls[0]).file_path, '/x');
    });

    it('still rejects a name that does not match any tool, even case-insensitively', () => {
      const result = parseTextToolCalls(
        '<tool_call>{"name":"PackageJsonName","arguments":{}}</tool_call>',
        new Set(['Read', 'Write']),
      );
      assert.strictEqual(result.toolCalls.length, 0);
      assert.strictEqual(result.malformedCount, 1);
    });
  });

  describe('Hermes-style function tags with whitespace', () => {
    it('parses <function> tag with whitespace inside <tool_call>', () => {
      const content = `<tool_call>
 <function=Read>
 <parameter=file_path>
 /foo/bar
 </parameter>
 </function>
</tool_call>`;
      const result = parseTextToolCalls(content, new Set(['Read']));
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Read');
      assert.strictEqual(argsOf(result.toolCalls[0]).file_path, '/foo/bar');
    });

    it('parses multiple parameters with whitespace in Hermes format', () => {
      const content = `<tool_call>
 <function=Grep>
 <parameter=pattern>
 from.*providers/auth-modes
 </parameter>
 <parameter=path>
 /Users/vilaca/work/factory/main/src/core
 </parameter>
 <parameter=include_content>
 true
 </parameter>
 </function>
</tool_call>`;
      const result = parseTextToolCalls(content, new Set(['Grep']));
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Grep');
      assert.strictEqual(argsOf(result.toolCalls[0]).pattern, 'from.*providers/auth-modes');
      assert.strictEqual(
        argsOf(result.toolCalls[0]).path,
        '/Users/vilaca/work/factory/main/src/core',
      );
      assert.strictEqual(argsOf(result.toolCalls[0]).include_content, true);
    });

    it('parses mixed quoted and unquoted parameter values in Hermes format', () => {
      const content = `<tool_call>
 <function=Write>
 <parameter=file_path>
 /some/path.ts
 </parameter>
 <parameter=content>
 export function foo() { }
 </parameter>
 </function>
</tool_call>`;
      const result = parseTextToolCalls(content, new Set(['Write']));
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Write');
      assert.strictEqual(argsOf(result.toolCalls[0]).file_path, '/some/path.ts');
      assert.match(argsOf(result.toolCalls[0]).content as string, /export function foo/);
    });

    it('handles capitalized booleans like True/False in parameter values', () => {
      const content = `<tool_call>
 <function=Grep>
 <parameter=pattern>
 from.*auth-modes
 </parameter>
 <parameter=path>
 /Users/vilaca/work/factory/main/src/core
 </parameter>
 <parameter=include_content>
 True
 </parameter>
 </function>
 </tool_call>`;
      const result = parseTextToolCalls(content, new Set(['Grep']));
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].function.name, 'Grep');
      assert.strictEqual(argsOf(result.toolCalls[0]).pattern, 'from.*auth-modes');
      assert.strictEqual(
        argsOf(result.toolCalls[0]).path,
        '/Users/vilaca/work/factory/main/src/core',
      );
      // "True" as a string (not JSON-parseable as boolean, so kept as string)
      assert.strictEqual(argsOf(result.toolCalls[0]).include_content, 'True');
    });
  });
});
