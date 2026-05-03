import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getToolDefinitions, getTool, getAllTools } from '../../src/tools/index.js';
import type { ToolCategory } from '../../src/tools/types.js';

describe('Tool registry', () => {
  const expectedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

  it('getAllTools returns all 6 tools', () => {
    const tools = getAllTools();
    assert.strictEqual(tools.length, 6);
    const names = tools.map(t => t.name);
    for (const name of expectedTools) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
    }
  });

  it('getToolDefinitions returns definitions for all tools', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 6);
    for (const def of defs) {
      assert.strictEqual(def.type, 'function');
      assert.ok(def.function.name, 'definition must have a name');
      assert.ok(def.function.description, 'definition must have a description');
      assert.strictEqual(def.function.parameters.type, 'object');
    }
  });

  it('getTool finds tools by exact name', () => {
    for (const name of expectedTools) {
      const tool = getTool(name);
      assert.ok(tool, `getTool('${name}') returned undefined`);
      assert.strictEqual(tool!.name, name);
    }
  });

  it('getTool finds tools case-insensitively', () => {
    const tool = getTool('read');
    assert.ok(tool);
    assert.strictEqual(tool!.name, 'Read');

    const tool2 = getTool('BASH');
    assert.ok(tool2);
    assert.strictEqual(tool2!.name, 'Bash');
  });

  it('getTool returns undefined for unknown tools', () => {
    assert.strictEqual(getTool('NonExistent'), undefined);
    assert.strictEqual(getTool(''), undefined);
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
      const tool = getTool(name);
      assert.ok(tool, `getTool('${name}') returned undefined`);
      assert.strictEqual(tool!.category, category, `${name} should have category '${category}'`);
    }
  });

  it('tool definitions have required parameters marked', () => {
    const readTool = getTool('Read');
    assert.ok(readTool);
    const readParams = readTool!.definition.function.parameters as any;
    assert.ok(readParams.required?.includes('file_path'));

    const editTool = getTool('Edit');
    assert.ok(editTool);
    const editParams = editTool!.definition.function.parameters as any;
    assert.ok(editParams.required?.includes('file_path'));
    assert.ok(editParams.required?.includes('old_string'));
    assert.ok(editParams.required?.includes('new_string'));

    const bashTool = getTool('Bash');
    assert.ok(bashTool);
    const bashParams = bashTool!.definition.function.parameters as any;
    assert.ok(bashParams.required?.includes('command'));
  });

  it('each tool has a matching name in definition', () => {
    const tools = getAllTools();
    for (const tool of tools) {
      assert.strictEqual(
        tool.name,
        tool.definition.function.name,
        `${tool.name} handler name must match definition name`,
      );
    }
  });
});
