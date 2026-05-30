import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStartupPickerDataSource } from '../../../../src/cli/startup/picker-data.js';

let originalHome: string | undefined;
let originalXdg: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  tempHome = path.join(os.tmpdir(), `factory-startup-menu-${crypto.randomUUID()}`);
  fs.mkdirSync(tempHome, { recursive: true });
  process.env.HOME = tempHome;
  process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('createStartupPickerDataSource', () => {
  it('allows adding the first key for a simple-prompt provider', async () => {
    const props = createStartupPickerDataSource();

    assert.strictEqual(props.multiKeyProviders.has('anthropic'), true);
    assert.strictEqual(props.multiKeyProviders.has('copilot'), false);

    const before = await props.loadKeysForProvider('anthropic');
    assert.deepStrictEqual(before, []);

    const id = await props.saveKey('anthropic', 'sk-ant-test-123456');
    assert.ok(id);

    const after = await props.loadKeysForProvider('anthropic');
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0]?.id, id);
    assert.strictEqual(after[0]?.fingerprint, '3456');
  });
});
