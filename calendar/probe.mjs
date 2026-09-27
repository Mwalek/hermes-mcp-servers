// Starts the calendar MCP server from this directory's node_modules and checks it over stdio.
//
//   node probe.mjs tools              Server starts and lists list-calendars. Needs no Google access (CI).
//   node probe.mjs call <account>     Real list-calendars call; passes only if <account> is among the
//                                     calendars and the call is not an error. Needs
//                                     GOOGLE_OAUTH_CREDENTIALS and GOOGLE_CALENDAR_MCP_TOKEN_PATH.
//
// Prints one line: PASS or FAIL and why. Never prints tokens or event content.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, 'node_modules/@cocal/google-calendar-mcp/build/index.js');
const [mode, account] = process.argv.slice(2);
const TIMEOUT_MS = 90_000;

if (mode !== 'tools' && !(mode === 'call' && account)) {
  console.log('FAIL usage: node probe.mjs tools | node probe.mjs call <account>');
  process.exit(2);
}

// In tools mode the server must start with no Google access. It refuses to start without a
// credentials file, so give it an obviously fake one in a temp directory and no token.
const env = { ...process.env };
if (mode === 'tools') {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-probe-'));
  const fake = join(dir, 'gcp-oauth.keys.json');
  writeFileSync(fake, JSON.stringify({
    installed: {
      client_id: 'fake-client-for-ci.apps.googleusercontent.com',
      client_secret: 'fake-secret-for-ci',
      redirect_uris: ['http://localhost'],
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  }));
  env.GOOGLE_OAUTH_CREDENTIALS = fake;
  env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = join(dir, 'tokens.json');
}

const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', process.env.PROBE_DEBUG ? 'inherit' : 'ignore'] });
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const finish = (ok, why) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}: ${why}`);
  child.kill();
  process.exit(ok ? 0 : 1);
};
setTimeout(() => finish(false, `no answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS).unref();
child.on('exit', (code) => finish(false, `server exited early with code ${code}`));
child.on('error', (err) => finish(false, `could not start server: ${err.message}`));

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.id === 1) {
    if (msg.error) return finish(false, `initialize failed: ${msg.error.message}`);
    send({ method: 'notifications/initialized' });
    if (mode === 'tools') send({ id: 2, method: 'tools/list' });
    else send({ id: 2, method: 'tools/call', params: { name: 'list-calendars', arguments: {} } });
    return;
  }
  if (msg.id !== 2) return;
  if (msg.error) return finish(false, `request failed: ${msg.error.message}`);
  if (mode === 'tools') {
    const names = (msg.result?.tools ?? []).map((t) => t.name);
    return names.includes('list-calendars')
      ? finish(true, `${names.length} tools, list-calendars present`)
      : finish(false, `list-calendars missing from ${names.length} tools`);
  }
  if (msg.result?.isError) return finish(false, 'list-calendars returned an error');
  const text = JSON.stringify(msg.result ?? {});
  return text.includes(account)
    ? finish(true, `list-calendars includes ${account}`)
    : finish(false, `list-calendars does not include ${account}`);
}

send({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});
