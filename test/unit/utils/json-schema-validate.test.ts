import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateAgainstSchema } from '../../../src/utils/json-schema-validate.js';

describe('validateAgainstSchema', () => {
  it('returns null when value matches a flat object schema', () => {
    const schema = {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
      },
    };
    assert.strictEqual(validateAgainstSchema(schema, { file_path: '/etc/hosts' }), null);
    assert.strictEqual(
      validateAgainstSchema(schema, { file_path: '/etc/hosts', offset: 10 }),
      null,
    );
  });

  it('reports the missing required field by name', () => {
    const schema = {
      type: 'object',
      required: ['file_path', 'content'],
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    };
    const err = validateAgainstSchema(schema, { file_path: '/tmp/a' });
    assert.match(err ?? '', /missing required field "content"/);
  });

  it('reports the wrong type with field name and observed type', () => {
    const schema = {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'number' } },
    };
    const err = validateAgainstSchema(schema, { count: 'twelve' });
    assert.match(err ?? '', /count must be a number/);
    assert.match(err ?? '', /string/);
  });

  it('catches arrays passed where an object is expected', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const err = validateAgainstSchema(schema, []);
    assert.match(err ?? '', /must be an object/);
    assert.match(err ?? '', /array/);
  });

  it('catches null passed where a string is expected', () => {
    const schema = {
      type: 'object',
      required: ['file_path'],
      properties: { file_path: { type: 'string' } },
    };
    const err = validateAgainstSchema(schema, { file_path: null });
    assert.match(err ?? '', /file_path must be a string/);
    assert.match(err ?? '', /null/);
  });

  it('accepts extra unknown fields (open by default)', () => {
    const schema = {
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'string' } },
    };
    assert.strictEqual(validateAgainstSchema(schema, { x: 'ok', y: 'extra' }), null);
  });

  it('enforces integer vs number', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer' } },
    };
    assert.strictEqual(validateAgainstSchema(schema, { n: 5 }), null);
    const err = validateAgainstSchema(schema, { n: 5.5 });
    assert.match(err ?? '', /must be an integer/);
  });

  it('rejects NaN and Infinity for number fields', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } };
    assert.match(validateAgainstSchema(schema, { n: NaN }) ?? '', /must be a number/);
    assert.match(validateAgainstSchema(schema, { n: Infinity }) ?? '', /must be a number/);
  });

  it('honors enum constraints', () => {
    const schema = {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['read', 'write'] } },
    };
    assert.strictEqual(validateAgainstSchema(schema, { mode: 'read' }), null);
    const err = validateAgainstSchema(schema, { mode: 'execute' });
    assert.match(err ?? '', /must be one of/);
    assert.match(err ?? '', /"read"/);
  });

  it('validates array element types via items', () => {
    const schema = {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' } } },
    };
    assert.strictEqual(validateAgainstSchema(schema, { names: ['a', 'b'] }), null);
    const err = validateAgainstSchema(schema, { names: ['a', 7] });
    assert.match(err ?? '', /names\[1\]/);
    assert.match(err ?? '', /must be a string/);
  });

  it('skips validation silently when the schema is missing or malformed', () => {
    assert.strictEqual(validateAgainstSchema(undefined, { x: 1 }), null);
    assert.strictEqual(validateAgainstSchema(null, { x: 1 }), null);
    assert.strictEqual(validateAgainstSchema('not-a-schema', { x: 1 }), null);
    // Unknown type keyword → skip without error (MCP tools may bring in
    // shapes we don't understand; we'd rather under-validate than
    // refuse registration).
    assert.strictEqual(validateAgainstSchema({ type: 'mysterious' }, 'anything'), null);
  });

  it('validates the real Read tool schema shape', () => {
    // The exact shape from src/tools/read.ts — keep this in sync if Read's
    // schema changes so the boundary stays observable through the test.
    const readSchema = {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
    };
    assert.strictEqual(validateAgainstSchema(readSchema, { file_path: '/etc/hosts' }), null);
    assert.match(validateAgainstSchema(readSchema, {}) ?? '', /missing required field "file_path"/);
    assert.match(
      validateAgainstSchema(readSchema, { file_path: 7 }) ?? '',
      /file_path must be a string/,
    );
  });
});
