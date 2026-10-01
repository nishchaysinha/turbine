#!/usr/bin/env node
/**
 * Desktop end-to-end test: drives the real Turbine debug build (real PTYs,
 * real Rust backend, real hook server) through the dev debug bridge
 * (src-tauri/src/debug_bridge.rs) and screenshots each step.
 *
 * Prerequisites (Linux): a built debug app (`cd src-tauri && cargo build`),
 * the Vite dev server (`pnpm dev`), Xvfb and ImageMagick (`import`).
 *
 *   node scripts/e2e/desktop.mjs            # launches Xvfb + the app itself
 *   E2E_ATTACH=1 node scripts/e2e/desktop.mjs  # use an app already running
 *
 * Output: docs/testing/desktop/*.png and docs/testing/desktop/README.md
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'docs/testing/desktop');
const BRIDGE = 'http://127.0.0.1:4446';
const DISPLAY = process.env.DISPLAY_NUM || ':98';
const results = [];
const shots = [];
let shotIndex = 0;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[desktop-e2e]', ...a);

/** Evaluates `js` (an async function body) in the app and JSON-decodes its return value. */
async function ev(js) {
  const body = `const __r = await (async () => { ${js}\n })(); return JSON.stringify(__r === undefined ? null : __r);`;
  const res = await fetch(`${BRIDGE}/eval`, { method: 'POST', body });
  const text = await res.text();
  if (text.startsWith('ERR:')) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shot(name, caption) {
  const file = `${String(++shotIndex).padStart(2, '0')}-${name}.png`;
  execSync(`import -window root -crop 1280x800+0+0 "${join(outDir, file)}"`, { env: { ...process.env, DISPLAY } });
  shots.push({ file, caption });
}

async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    log(`✗ ${name}\n    ${e.stack || e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function waitFor(fn, msg, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${msg}${last instanceof Error ? ` (${last.message})` : ''}`);
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-e2e-'));
  const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe', shell: '/bin/sh' });
  sh('git init -q -b main && git config user.email e2e@example.com && git config user.name e2e');
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  writeFileSync(
    join(dir, 'src/server.ts'),
    "import express from 'express';\nimport cors from 'cors';\n\nexport function createServer(port: number) {\n  const app = express();\n  app.use(cors());\n  return app.listen(port);\n}\n",
  );
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "api-server",\n  "version": "1.3.2"\n}\n');
  writeFileSync(join(dir, 'README.md'), '# api-server\n');
  sh('git add -A && git commit -qm init && git checkout -qb feature/rate-limit');
  writeFileSync(
    join(dir, 'src/server.ts'),
    readFileSync(join(dir, 'src/server.ts'), 'utf8').replace(
      'app.use(cors());',
      "app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));\n  app.use(rateLimit({ windowMs: 60_000, max: 100 }));",
    ),
  );
  sh('git commit -qam "rate limit"');
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "api-server",\n  "version": "1.4.0"\n}\n');
  writeFileSync(join(dir, 'src/lib/rateLimit.ts'), "export { rateLimit } from 'express-rate-limit';\n");
  writeFileSync(join(dir, 'README.md'), '# api-server\n\n## Limits\n100 req/min\n');
  sh('git add README.md');
  return dir;
}

async function launch() {
  if (process.env.E2E_ATTACH) return;
  const app = join(root, 'src-tauri/target/debug/turbine-app');
  assert(existsSync(app), `debug build missing at ${app} (cd src-tauri && cargo build)`);
  children.push(spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24'], { stdio: 'ignore' }));
  await sleep(800);
  // Fresh HOME/XDG data dir: a clean database and app state for every run.
  const home = mkdtempSync(join(tmpdir(), 'turbine-e2e-home-'));
  children.push(
    spawn(app, [], {
      stdio: 'ignore',
      env: {
        ...process.env,
        DISPLAY,
        HOME: home,
        XDG_DATA_HOME: join(home, '.local/share'),
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
      },
    }),
  );
  await waitFor(async () => (await fetch(`${BRIDGE}/ping`)).ok, 'debug bridge up', 60000);
  // Software GL under Xvfb paints stale WebGL frames; use the DOM renderer.
  // The reload can tear down the page before the bridge answers; that's fine.
  await ev("localStorage.setItem('turbine.terminalRenderer','dom'); setTimeout(() => location.reload(), 50); return 1").catch(() => {});
  await sleep(4000);
  await waitFor(() => ev('return Boolean(window.__turbine)'), 'app ready', 30000);
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const repo = makeRepo();
  await launch();
  let panes = [];

  const type = (paneId, text) =>
    ev(`await window.__dbgInvoke('pty_write', { paneId: ${JSON.stringify(paneId)}, data: Array.from(new TextEncoder().encode(${JSON.stringify(text)})) }); return 1;`);
  const hook = (paneId, event, payload) =>
    type(paneId, `printf '%s' '${JSON.stringify(payload)}' | "$TURBINE_HOOK_SCRIPT" ${event} claude >/dev/null\r`);
  const rows = () => ev('return window.__turbine.agentStatus.getState().rows');

  await step('Open a project as a workspace with two terminals', async () => {
    panes = await ev(`
      const T = window.__turbine;
      const ws = T.workspace.getState().createWorkspace('api-server');
      T.workspace.setState((s) => ({ workspaces: s.workspaces.map((w) => w.id === ws.id ? { ...w, panes: w.panes.map((p) => ({ ...p, type: 'terminal', workingDirectory: ${JSON.stringify(repo)}, title: 'claude · api' })) } : w) }));
      await new Promise((r) => setTimeout(r, 2500));
      const st = T.workspace.getState();
      return st.workspaces.find((w) => w.id === ws.id).panes.map((p) => p.id);`);
    assert(panes.length === 1, 'one pane');
    const env = await waitFor(async () => {
      await type(panes[0], 'clear; echo "pane=$TURBINE_PANE_ID"\r');
      await sleep(600);
      const text = await ev(`const t = window.__turbineTerminals.get(${JSON.stringify(panes[0])}).terminal.buffer.active; let s=''; for (let i=0;i<t.length;i++) s += (t.getLine(i)?.translateToString(true) ?? '') + '\\n'; return s;`);
      return text.includes(`pane=${panes[0]}`) ? text : null;
    }, 'PTY sees TURBINE_PANE_ID');
    assert(env, 'pane id env');
  });

  await step('Agent hooks report status through the hub', async () => {
    await hook(panes[0], 'UserPromptSubmit', { prompt: 'Add rate limiting and cover it with tests' });
    await hook(panes[0], 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm vitest run' } });
    const row = await waitFor(async () => (await rows())[panes[0]]?.tool === 'Bash' && (await rows())[panes[0]], 'working row');
    assert(row.state === 'working' && row.prompt.startsWith('Add rate limiting'), 'working with prompt');
  });

  await step('Swarm agent: prompt is shell-escaped and its exit code completes the run', async () => {
    const res = await ev(`
      const T = window.__turbine;
      await window.__dbgInvoke('save_agent_preset', { preset: { id: 'e2e-fake', name: 'Fake Agent', role: 'Builder', cli_command_template: 'printf "building: %s\\\\n" "{{prompt}}"; sleep 1; echo "ünïcode ✓"; (exit 3)' } });
      const ws = T.workspace.getState().workspaces.find((w) => w.id === T.workspace.getState().activeWorkspaceId);
      const prompt = 'Fix "quotes" $(touch /tmp/turbine-e2e-pwned) \`id\` & it\\'s $HOME!';
      const run = await T.swarm.getState().startAdHocRun(${JSON.stringify(repo)}, prompt, ws.id, ws.panes[0].id);
      const agent = await T.swarm.getState().spawnAgent(run.id, 'e2e-fake', prompt, ${JSON.stringify(repo)});
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const a = T.swarm.getState().agents.get(run.id).find((x) => x.id === agent.id);
        if (a.status !== 'running') return { status: a.status, exit: a.exit_code, run: T.swarm.getState().runs.find((r) => r.id === run.id).status, summary: a.output_summary, paneId: agent.pane_id };
      }
      return { status: 'still running' };`);
    assert(res.status === 'failed' && res.exit === 3 && res.run === 'Failed', `agent completed via exit marker: ${JSON.stringify(res)}`);
    assert(res.summary.includes('building: Fix "quotes" $(touch /tmp/turbine-e2e-pwned)'), 'prompt arrived verbatim');
    assert(res.summary.includes('ünïcode ✓'), 'UTF-8 intact in agent output');
    assert(!existsSync('/tmp/turbine-e2e-pwned'), 'no command injection');
    panes = await ev('const T = window.__turbine; return T.workspace.getState().workspaces.find((w) => w.id === T.workspace.getState().activeWorkspaceId).panes.map((p) => p.id);');
    await sleep(500);
    shot('swarm-agent', 'A swarm agent with a hostile prompt: printed verbatim, exit code 3 reported through the hub');
  });

  await step('Command center: needs-you, approve, done with reply', async () => {
    const agentPane = panes[1];
    await hook(agentPane, 'UserPromptSubmit', { prompt: 'Review the diff for security issues' });
    await hook(agentPane, 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    await waitFor(async () => (await rows())[agentPane]?.state === 'blocked', 'blocked');
    await ev(`document.querySelector('[aria-label="Agents"]').click(); return 1;`);
    await sleep(800);
    const badge = await ev(`return document.querySelector('.activity-bar__badge')?.innerText`);
    assert(badge === '1', `needs-you badge, got ${badge}`);
    shot('command-center', 'Agents panel: every agent, live state, current tool, and one-click Approve/Deny');
    await hook(panes[0], 'Stop', { last_assistant_message: 'Added express-rate-limit (100 req/min) and 6 tests. All green.' });
    await waitFor(async () => (await rows())[panes[0]]?.state === 'done', 'done');
    await sleep(500);
    shot('agent-done', 'A finished turn shows the agent’s last message and a reply box; a toast fires when you are elsewhere');
  });

  await step('Command palette: jump straight to the agent that needs you', async () => {
    const agentPane = panes[1];
    const items = await ev(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const input = document.querySelector('.command-palette__input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '>go to');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return [...document.querySelectorAll('.command-palette__item')].map((el) => el.innerText.replace(/\\s+/g, ' '));`);
    assert(items.length >= 2 && items[0].includes('Needs you'), `blocked agent listed first: ${JSON.stringify(items)}`);
    shot('palette-agent-jump', 'Command palette (Ctrl+Shift+P): agents sorted by who needs you, one keystroke away');
    await ev(`document.querySelector('.command-palette__item').click(); return 1;`);
    await sleep(300);
    const after = await ev(`return { open: Boolean(document.querySelector('.command-palette')), unread: Boolean(window.__turbine.agentStatus.getState().unread[${JSON.stringify(agentPane)}]) }`);
    assert(!after.open && !after.unread, `jumped and marked read: ${JSON.stringify(after)}`);
  });

  await step('Review: all changes include staged, unstaged and new files', async () => {
    const summary = await ev(`
      const T = window.__turbine;
      const ws = T.workspace.getState().workspaces.find((w) => w.id === T.workspace.getState().activeWorkspaceId);
      document.querySelector('[aria-label="Agents"]').click();
      T.workspace.setState((s) => ({ workspaces: s.workspaces.map((w) => w.id === ws.id ? { ...w, panes: w.panes.map((p) => p.id === ${JSON.stringify(panes[1])} ? { ...p, type: 'diff_viewer', workingDirectory: ${JSON.stringify(repo)}, title: 'Review' } : p) } : w) }));
      for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 200)); if (document.querySelectorAll('.diff-file-item').length) break; }
      return [...document.querySelectorAll('.diff-file-item__name')].map((e) => e.innerText);`);
    assert(JSON.stringify(summary) === '["README.md","package.json","rateLimit.ts"]', `files ${summary}`);
  });

  await step('Review: notes on lines are sent to the agent as one paste', async () => {
    const res = await ev(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const setVal = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const addNote = async (match, text) => {
        [...document.querySelectorAll('.review-line')].find((l) => l.innerText.includes(match)).click(); await sleep(200);
        setVal(document.querySelector('.review-note-editor__input'), text); await sleep(100);
        [...document.querySelectorAll('.diff-btn')].find((b) => b.innerText === 'Add note').click(); await sleep(200);
      };
      await addNote('1.4.0', 'Add a CHANGELOG entry for 1.4.0');
      await addNote('express-rate-limit', 'Pin express-rate-limit in package.json');
      return document.querySelector('.review-bar')?.innerText;`);
    assert(res.includes('2 review notes'), 'two notes');
    shot('review-notes', 'Review: scoped diff, file list, line numbers and inline notes');
    await type(panes[0], `stty -icanon; cat > ${repo}/.received\r`);
    await sleep(800);
    await ev(`
      [...document.querySelectorAll('.diff-btn')].find((b) => b.innerText.startsWith('Send to agent')).click();
      await new Promise((r) => setTimeout(r, 300));
      return 1;`);
    shot('review-send', 'Send review notes to an agent (submitted) or paste into a plain terminal (no Enter)');
    await ev(`[...document.querySelectorAll('.review-send-menu__item')].find((b) => b.innerText.includes('claude')).click(); return 1;`);
    await sleep(1200);
    await type(panes[0], '\x04');
    await sleep(500);
    const received = readFileSync(join(repo, '.received'), 'utf8');
    assert(received.startsWith('\x1b[200~') && received.includes('File: package.json') && received.includes('User comment: "Add a CHANGELOG entry for 1.4.0"'), 'bracketed review prompt');
  });

  await step('Review: branch scope compares against the merge base', async () => {
    const files = await ev(`
      [...document.querySelectorAll('.diff-scope')].find((b) => b.innerText === 'Branch').click();
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 200)); if (document.querySelector('.diff-viewer__summary')?.innerText.includes('vs main')) break; }
      return [...document.querySelectorAll('.diff-file-item__name')].map((e) => e.innerText);`);
    assert(files.includes('server.ts'), `committed branch change shown: ${files}`);
    shot('review-branch', 'Branch scope: everything on feature/rate-limit since it left main');
  });

  await step('Swarm: runs left running by a previous session are marked interrupted', async () => {
    const res = await ev(`
      const now = new Date().toISOString();
      const run = { id: 'stale-' + Date.now(), task_id: null, project_path: ${JSON.stringify(repo)}, status: 'Running', current_role: 'Builder', prompt: 'Left running when Turbine quit', started_at: now, updated_at: now };
      await window.__dbgInvoke('save_swarm_run', { run });
      await window.__dbgInvoke('save_swarm_agent', { agent: { id: run.id + '-a', swarm_run_id: run.id, preset_id: null, pane_id: 'gone', role: 'Builder', command: 'x', status: 'running', exit_code: null, output_summary: null, started_at: now, completed_at: null } });
      await window.__turbine.swarm.getState().loadRuns(${JSON.stringify(repo)});
      const agents = await window.__dbgInvoke('load_swarm_agents', { swarmRunId: run.id });
      window.__turbine.swarm.getState().setActiveRun(null);
      document.querySelector('[aria-label="Swarm"]').click();
      await new Promise((r) => setTimeout(r, 600));
      return { run: window.__turbine.swarm.getState().runs.find((r) => r.id === run.id)?.status, agent: agents[0].status, summary: agents[0].output_summary };`);
    assert(res.run === 'Failed' && res.agent === 'failed' && /Interrupted/.test(res.summary), `stale run reconciled: ${JSON.stringify(res)}`);
    shot('swarm-interrupted', 'Swarm runs whose agents died with the app show as Failed (interrupted) instead of running forever');
  });

  await step('Task board: create, run with an agent; hostile titles stay literal', async () => {
    const res = await ev(`
      document.querySelector('[aria-label="Tasks"]').click();
      await new Promise((r) => setTimeout(r, 800));
      const input = document.querySelector('.task-board__add-form input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Fix "it\\'s" $(touch /tmp/turbine-e2e-task-pwned) \\\`id\\\`');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      input.form.requestSubmit();
      await new Promise((r) => setTimeout(r, 600));
      const card = [...document.querySelectorAll('.task-board [draggable=true]')].find((c) => c.innerText.includes('task-pwned'));
      card.querySelector('button').click();
      await new Promise((r) => setTimeout(r, 300));
      [...document.querySelectorAll('.task-board__agent-selector button')].find((b) => b.innerText.includes('Gemini')).click();
      const T = window.__turbine;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const ws = T.workspace.getState().workspaces.find((w) => w.id === T.workspace.getState().activeWorkspaceId);
        const pane = ws.panes.find((p) => p.label?.startsWith('Gemini CLI'));
        const row = pane && T.agentStatus.getState().rows[pane.id];
        if (row?.exitCode != null) {
          const t = window.__turbineTerminals.get(pane.id).terminal.buffer.active;
          let text = ''; for (let j = 0; j < t.length; j++) text += (t.getLine(j)?.translateToString(true) ?? '') + '\\n';
          return { state: row.state, exit: row.exitCode, task: T.tasks.getState().tasks.find((x) => x.title.includes('task-pwned')).status, text };
        }
      }
      return { state: 'none' };`);
    assert(res.state === 'done' && typeof res.exit === 'number', `agent pane reported its exit: ${JSON.stringify(res).slice(0, 300)}`);
    assert(res.task === 'in_progress', `task moved to in progress: ${res.task}`);
    assert(!existsSync('/tmp/turbine-e2e-task-pwned'), 'no command injection from task title');
    assert(!/^\{\}$/m.test(res.text), 'exit marker prints nothing');
    await sleep(1500);
    shot('task-run', 'Task board → Run with an agent: the title is passed literally and the pane reports its exit');
  });

  await step('Settings: hook install toggle and renderer switch', async () => {
    const text = await ev(`
      document.querySelector('[aria-label="Settings"]').click();
      await new Promise((r) => setTimeout(r, 400));
      [...document.querySelectorAll('.settings-panel__tab')].find((b) => b.innerText === 'Agents').click();
      await new Promise((r) => setTimeout(r, 300));
      return document.querySelector('.settings-panel__content').innerText;`);
    assert(text.includes('Claude Code status hooks') && text.includes('GPU terminal rendering'), 'agents settings');
    shot('settings-agents', 'Settings → Agents');
  });

  writeReport();
  const failed = results.filter((r) => !r.ok).length;
  log(`${results.length - failed}/${results.length} steps passed`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

function writeReport() {
  writeFileSync(
    join(outDir, 'README.md'),
    [
      '# Turbine desktop – end-to-end run',
      '',
      'Generated by `scripts/e2e/desktop.mjs` against the real debug build (real PTYs, Rust backend and agent hook server) on a virtual display.',
      '',
      '| Result | Step | Time |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name}${r.error ? `<br><sub>${r.error.replace(/\|/g, '\\|').slice(0, 300)}</sub>` : ''} | ${r.ms}ms |`),
      '',
      ...shots.flatMap((s) => [`### ${s.caption}`, '', `![${s.caption}](./${s.file})`, '']),
    ].join('\n'),
  );
}

function cleanup() {
  for (const c of children.reverse()) {
    try {
      c.kill();
    } catch {}
  }
}

main().catch((e) => {
  console.error(e);
  writeReport();
  cleanup();
  process.exit(1);
});
