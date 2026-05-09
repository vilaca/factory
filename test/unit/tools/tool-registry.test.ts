import { describe, it } from 'node:test';
import assert from 'node:assert';
import { defaultRegistry } from '../../../src/tools/index.js';
import type { ToolCategory } from '../../../src/tools/types.js';

describe('Tool registry', () => {
  const expectedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'];

  it('getAll returns all 7 tools', () => {
    const tools = defaultRegistry.getAll();
    assert.strictEqual(tools.length, 7);
    const names = tools.map(t => t.name);
    for (const name of expectedTools) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
    }
  });

  it('getDefinitions returns definitions for all tools', () => {
    const defs = defaultRegistry.getDefinitions();
    assert.strictEqual(defs.length, 7);
    for (const def of defs) {
      assert.strictEqual(def.type, 'function');
      assert.ok(def.function.name, 'definition must have a name');
      assert.ok(def.function.description, 'definition must have a description');
      assert.strictEqual(def.function.parameters.type, 'object');
    }
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
});
