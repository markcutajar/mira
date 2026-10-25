import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Permissions, summarise } from '../src/permissions.ts';

const prompt = (id: string) => ({ id, sessionId: 's-1', system: 'mira', tool: 'Bash', summary: 'npm test', askedAt: '2026-10-25T18:00:00.000Z' });

describe('Permissions', () => {
  it('replies at once when nobody is watching', async () => {
    const permissions = new Permissions({ waitMs: 5000, watching: () => false });
    assert.equal(await permissions.ask(prompt('a')), null);
    assert.equal(permissions.pending().length, 0);
  });

  it('holds the prompt for an answer while Mira is open', async () => {
    const permissions = new Permissions({ waitMs: 5000, watching: () => true });
    const decision = permissions.ask(prompt('a'));
    assert.deepEqual(permissions.pending().map((p) => p.id), ['a']);
    assert.equal(permissions.answer('a', 'allow'), true);
    assert.equal(await decision, 'allow');
    assert.equal(permissions.pending().length, 0);
  });

  it('hands back to the terminal when the wait runs out', async () => {
    const permissions = new Permissions({ waitMs: 20, watching: () => true });
    assert.equal(await permissions.ask(prompt('a')), null);
    assert.equal(permissions.answer('a', 'allow'), false);
  });

  it('drops a prompt whose session stopped waiting', async () => {
    const permissions = new Permissions({ waitMs: 5000, watching: () => true });
    const decision = permissions.ask(prompt('a'));
    permissions.cancel('a');
    assert.equal(await decision, null);
  });
});

describe('summarise', () => {
  it('shows the command, file or URL a tool wants', () => {
    assert.equal(summarise('Bash', { command: 'npm run test:e2e', description: 'Run tests' }), 'npm run test:e2e');
    assert.equal(summarise('Write', { file_path: 'src/auth.ts', content: 'x'.repeat(10000) }), 'src/auth.ts');
  });

  it('trims anything long', () => {
    assert.ok((summarise('Mystery', { blob: 'x'.repeat(5000) }) ?? '').length <= 500);
  });
});
