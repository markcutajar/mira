import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Inboxes, isInbox } from '../src/claude-code/inbox.ts';

const SESSION = '0b2c1d4e-5f60-4718-9a2b-3c4d5e6f7a8b';
const TOKEN = randomBytes(16).toString('hex');
// An inbox address as Claude Code makes them: a named pipe on Windows, a socket file elsewhere.
const address = () => (process.platform === 'win32' ? `\\\\.\\pipe\\cc-msg-${randomBytes(16).toString('hex')}` : join(tmpdir(), `mira-${randomBytes(4).toString('hex')}.sock`));

describe('session inboxes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-inbox-'));
  const file = join(dir, 'inboxes.json');
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("takes only Claude Code's own inbox addresses, with a token", () => {
    assert.ok(isInbox('\\\\.\\pipe\\LOCAL\\cc-msg-0337493ba7fe34ce95f7a8621dad6624', TOKEN));
    assert.ok(isInbox('/tmp/cc-socks-501/4242.sock', TOKEN));
    assert.ok(!isInbox('\\\\.\\pipe\\something-else', TOKEN));
    assert.ok(!isInbox('\\\\server\\pipe\\cc-msg-0337493ba7fe34ce95f7a8621dad6624', TOKEN));
    assert.ok(!isInbox('/tmp/cc-socks-501/4242.sock', 'short'));
    assert.ok(!isInbox('/tmp/x.sock', undefined));
  });

  it('keeps what hooks name between restarts, drops stale ones and forgets ended sessions', () => {
    const inboxes = new Inboxes(file);
    inboxes.note(SESSION, '\\\\.\\pipe\\cc-msg-0337493ba7fe34ce95f7a8621dad6624', TOKEN);
    inboxes.note('not-valid', 'nope', TOKEN);
    assert.ok(new Inboxes(file).has(SESSION));
    assert.ok(!new Inboxes(file).has('not-valid'));
    const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { at: string }>;
    writeFileSync(file, JSON.stringify({ [SESSION]: { ...kept[SESSION], at: '2026-01-01T00:00:00.000Z' } }));
    assert.ok(!new Inboxes(file).has(SESSION)); // named too long ago
    inboxes.forget(SESSION);
    assert.ok(!inboxes.has(SESSION));
  });

  it('delivers a message as Claude Code reads it: the token first, then the message from Mira', async () => {
    const socket = address();
    const got: string[] = [];
    const server = createServer((c) => {
      let text = '';
      c.on('data', (d) => { text += d.toString(); });
      c.on('end', () => got.push(text));
    });
    await new Promise<void>((done) => server.listen(socket, done));
    const inboxes = new Inboxes();
    assert.match((await inboxes.send(SESSION, 'hello')) ?? '', /doesn't know this session's inbox/);
    inboxes.note(SESSION, socket, TOKEN);
    assert.equal(await inboxes.send(SESSION, 'Can you also\ncheck the tests?'), null);
    await new Promise((done) => setTimeout(done, 100));
    const [auth, message] = (got[0] ?? '').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(auth, { type: 'auth', token: TOKEN });
    assert.deepEqual(message, { type: 'user', session_id: SESSION, from: 'Mira', message: { role: 'user', content: 'Can you also\ncheck the tests?' } });
    await new Promise((done) => server.close(done));
    // Once the session has gone, there's nothing to deliver to, and its inbox is forgotten.
    assert.match((await inboxes.send(SESSION, 'still there?')) ?? '', /isn't running any more/);
    assert.ok(!inboxes.has(SESSION));
  });
});
