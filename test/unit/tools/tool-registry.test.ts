import { describe, it } from 'node:test';
import assert from 'node:assert';
import { defaultRegistry } from '../../../src/tools/index.js';
import { TOOL_NAMES } from '../../../src/tools/types.js';
import type { ToolCategory } from '../../../src/tools/types.js';

describe('Tool registry', () => {
  // Respond is registered alongside the 7 built-ins (synthetic terminal tool
  // for the small-model reliability path; see src/tools/respond.ts). It's
  // counted here so the registry's storage assertions stay honest; the
  // agent loop filters it from the wire surface for strong-tier models.
  const expectedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'Respond'];

  it('getAll returns all 8 tools', () => {
    const tools = defaultRegistry.getAll();
    assert.strictEqual(tools.length, expectedTools.length);
    const names = tools.map(t => t.name);
    for (const name of expectedTools) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
    }
  });

  it('getDefinitions returns definitions for all tools', () => {
    const defs = defaultRegistry.getDefinitions();
    assert.strictEqual(defs.length, expectedTools.length);
    for (const def of defs) {
      assert.strictEqual(def.type, 'function');
      assert.ok(def.function.name, 'definition must have a name');
      assert.ok(def.function.description, 'definition must have a description');
      assert.strictEqual(def.function.parameters.type, 'object');
    }
  });

  it('getDefinitions honors the exclude set', () => {
    const all = defaultRegistry.getDefinitions();
    const filtered = defaultRegistry.getDefinitions({ exclude: new Set(['Respond']) });
    assert.strictEqual(filtered.length, all.length - 1);
    assert.ok(!filtered.some(d => d.function.name === 'Respond'));
  });

  it('get finds tools by exact name', () => {
    for (const name of expectedTools) {
      const tool = defaultRegistry.get(name);
      assert.ok(tool, `defaultRegistry.get('${name}') returned undefined`);
      assert.strictEqual(tool!.name, name);
    }
  });

  it('get finds tools case-insensitively', () => {
    const tool = defaultRegistry.get('read');
    assert.ok(tool);
    assert.strictEqual(tool!.name, 'Read');

    const tool2 = defaultRegistry.get('BASH');
    assert.ok(tool2);
    assert.strictEqual(tool2!.name, 'Bash');
  });

  it('get returns undefined for unknown tools', () => {
    assert.strictEqual(defaultRegistry.get('NonExistent'), undefined);
    assert.strictEqual(defaultRegistry.get(''), undefined);
  });

  it('all tools have correct categories', () => {
    const expectedCategories: Record<string, ToolCategory> = {
      Read: 'read-only',
      Write: 'write',
      Edit: 'write',
      Bash: 'execute',
      Glob: 'read-only',
      Grep: 'read-only',
    };

    for (const [name, category] of Object.entries(expectedCategories)) {
      const tool = defaultRegistry.get(name);
      assert.ok(tool, `defaultRegistry.get('${name}') returned undefined`);
      assert.strictEqual(tool!.category, category, `${name} should have category '${category}'`);
    }
  });

  it('tool definitions have required parameters marked', () => {
    const readTool = defaultRegistry.get('Read');
    assert.ok(readTool);
    const readParams = readTool!.definition.function.parameters as any;
    assert.ok(readParams.required?.includes('file_path'));

    const editTool = defaultRegistry.get('Edit');
    assert.ok(editTool);
    const editParams = editTool!.definition.function.parameters as any;
    assert.ok(editParams.required?.includes('file_path'));
    assert.ok(editParams.required?.includes('old_string'));
    assert.ok(editParams.required?.includes('new_string'));

    const bashTool = defaultRegistry.get('Bash');
    assert.ok(bashTool);
    const bashParams = bashTool!.definition.function.parameters as any;
    assert.ok(bashParams.required?.includes('command'));
  });

  it('each tool has a matching name in definition', () => {
    const tools = defaultRegistry.getAll();
    for (const tool of tools) {
      assert.strictEqual(
        tool.name,
        tool.definition.function.name,
        `${tool.name} handler name must match definition name`,
      );
    }
  });

  // TOOL_NAMES contract: the const is the single source of truth for
  // every built-in tool's name (system prompts, permission gates, text-
  // tool parser, agent reliability stack). A drift between TOOL_NAMES
  // and the registry means one side has a name the other doesn't know
  // about — silent fallthrough in every consumer that branches on the
  // missing name.
  //
  // Two TOOL_NAMES entries are intentionally NOT in defaultRegistry:
  //
  //   - Delegate: registered by `registerSubagentTool` at production
  //     startup (src/cli/startup/phase-trust-and-subagent.ts) because
  //     the handler factory `createDelegateTool` needs the live
  //     (provider, parentModel) pair to construct. defaultRegistry has
  //     no provider context; it can't register Delegate without a
  //     placeholder that would lie about the tool's real shape.
  //
  // If a new "deferred" tool joins this list, add it here and document
  // the construction-time requirement that prevents defaultRegistry
  // registration.
  const REGISTERED_AT_STARTUP = new Set<string>([TOOL_NAMES.Delegate]);

  // Test (a): every TOOL_NAMES entry is either in defaultRegistry or
  // explicitly carved out as a startup-registered tool.
  it('every TOOL_NAMES entry is either in defaultRegistry or carved out as startup-registered', () => {
    for (const name of Object.values(TOOL_NAMES)) {
      if (REGISTERED_AT_STARTUP.has(name)) continue;
      const handler = defaultRegistry.get(name);
      assert.ok(
        handler,
        `TOOL_NAMES.${name} has no registered handler in defaultRegistry — ` +
          `add the registration in ToolRegistry's constructor, remove the entry from TOOL_NAMES, ` +
          `or carve it out in REGISTERED_AT_STARTUP above with a justification.`,
      );
      assert.strictEqual(
        handler!.name,
        name,
        `defaultRegistry.get(${JSON.stringify(name)}) returned a handler whose name is ` +
          `${JSON.stringify(handler!.name)} — registry lookup is case-insensitive but the canonical ` +
          `handler.name must match TOOL_NAMES exactly.`,
      );
    }
  });

  // Test (b): every registered handler's name is one of TOOL_NAMES.
  // Catches the inverse drift: a handler registered under a name that
  // isn't tracked in TOOL_NAMES would be invisible to permission gates
  // and the text-tool parser, both of which only know names from the
  // const.
  it('every registered handler name appears in TOOL_NAMES', () => {
    const known = new Set<string>(Object.values(TOOL_NAMES));
    for (const tool of defaultRegistry.getAll()) {
      assert.ok(
        known.has(tool.name),
        `Tool ${JSON.stringify(tool.name)} is registered but not in TOOL_NAMES — ` +
          `add it to src/utils/tool-names.ts so security/permissions, the text-tool parser, ` +
          `and the reliability stack can refer to it by constant.`,
      );
    }
  });

  // Schema-validity invariant for the boundary validator in
  // src/core/agent/tool-calls/run-tool-calls-execute.ts. Built-in tools
  // must declare a meaningful JSON Schema so the validator can actually
  // protect them — an empty `properties: {}` would pass through every
  // call and defeat the point. MCP-supplied tools are forgiving by design
  // (they can carry arbitrary shapes), but the in-tree defaults are
  // contract.
  it('every built-in tool has a non-empty parameter schema', () => {
    for (const tool of defaultRegistry.getAll()) {
      const params = tool.definition.function.parameters as {
        type?: unknown;
        properties?: Record<string, unknown>;
        required?: unknown;
      };
      assert.strictEqual(params.type, 'object', `${tool.name}: parameters.type must be 'object'`);
      assert.ok(
        params.properties && Object.keys(params.properties).length > 0,
        `${tool.name}: parameters.properties must be non-empty`,
      );
      if (Array.isArray(params.required)) {
        for (const r of params.required as string[]) {
          assert.ok(
            r in params.properties!,
            `${tool.name}: required field "${r}" missing from properties`,
          );
        }
      }
    }
  });
});
