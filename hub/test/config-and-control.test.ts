import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { startupScript } from '../src/control.ts';

describe('config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-config-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps 90 days of events and lets quiet sessions go after an hour or twelve, unless told otherwise', () => {
    const defaults = loadConfig(join(dir, 'missing.json'));
    assert.equal(defaults.keepDays, 90);
    assert.deepEqual(defaults.quiet, { workingMinutes: 60, idleHours: 12 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ keepDays: 0, quiet: { idleHours: 24 } }));
    const mine = loadConfig(join(dir, 'config.json'));
    assert.equal(mine.keepDays, 0);
    assert.deepEqual(mine.quiet, { workingMinutes: 60, idleHours: 24 });
  });
});

describe('starting at login', () => {
  it('writes a script that starts the hub in the background', () => {
    const script = startupScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\code\\mira\\hub\\src\\control.ts');
    assert.match(script, /^@echo off\r\n/);
    assert.match(script, /"C:\\Program Files\\nodejs\\node\.exe" --disable-warning=ExperimentalWarning "C:\\code\\mira\\hub\\src\\control\.ts" start\r\n$/);
  });
});
