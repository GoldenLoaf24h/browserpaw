import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const chrome = process.env.BROWSERPAW_TEST_CHROME;
if (!chrome) throw new Error('Point BROWSERPAW_TEST_CHROME at Chrome for Testing.');
let cli = resolve(process.env.BROWSERPAW_TEST_CLI ?? 'app/native-server/dist/v5/cli.cjs');
const output = resolve(process.env.BROWSERPAW_TEST_RECEIPTS ?? '.artifacts/cli-live');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'browserpaw-v5-live-'));
const env = {
  ...process.env,
  BROWSERPAW_HOME: join(root, 'data'),
  BROWSERPAW_NO_UPDATE_CHECK: '1',
  HOME: root,
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  APPDATA: join(root, 'AppData'),
  ...(process.platform === 'win32' ? { USERPROFILE: root } : {}),
};
const productionHost = 'com.browserpaw.nativehost';
const registration = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + productionHost;
const report = { status: 'failed', checks: [], startedAt: new Date().toISOString() };
let browser;
let registered = false;
let dispatched = 0;
let markDispatch;
const dispatchStarted = new Promise((resolve) => {
  markDispatch = resolve;
});
const fixture = createServer((request, response) => {
  response.setHeader('connection', 'close');
  if (request.url === '/dispatch-marker') {
    if (request.method === 'POST') {
      dispatched++;
      markDispatch();
    }
    return response.end('marked');
  }
  if (request.url === '/file') {
    response.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': 'attachment; filename="fixture.txt"',
    });
    return response.end('browserpaw fixture download');
  }
  if (request.url === '/frame') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end('<label>Frame input <input id="inner"></label>');
  }
  if (request.url === '/debug-json') {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({ fixture: 'native-response' }));
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>BrowserPaw test</title>
  <label>Public name<input id="name"></label>
  <div id="editor" role="textbox" aria-label="Editor" contenteditable="true">Empty draft</div>
  <button id="reveal" onclick="document.body.append('Dynamic result')">Reveal</button>
  <label>Choice<select id="choice"><option value="one">One</option><option value="two">Two</option></select></label>
  <label>Colors<select id="colors" multiple><option value="blue">Blue</option><option value="red">Red</option></select></label>
  <label>Upload<input type="file" id="upload"></label><iframe src="/frame"></iframe>
  <p><button id="dialog" onclick="alert('fixture alert')">Alert fixture</button></p>
  <p><a href="/file">Download fixture</a></p>`);
});

async function run(label, args, expected = 0) {
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  let result;
  try {
    result = await exec(process.execPath, [cli, ...args, '--json'], {
      env,
      timeout: 40000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.ok(expectedCodes.includes(0));
  } catch (error) {
    if (typeof error.stdout === 'string')
      await writeFile(join(output, label + '.json'), error.stdout);
    if (expectedCodes.includes(error.code) && typeof error.stdout === 'string') {
      report.checks.push(label);
      return JSON.parse(error.stdout);
    }
    throw new Error(`${label}: ${error.stdout || error.message}`);
  }
  await writeFile(join(output, label + '.json'), result.stdout);
  report.checks.push(label);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  return receipt.data;
}

async function waitForHost(previousPid = 0) {
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline && browser.exitCode === null) {
    const record = await readFile(join(env.BROWSERPAW_HOME, 'host.json'), 'utf8').then(
      JSON.parse,
      () => undefined,
    );
    if (record?.pid && record.pid !== previousPid) {
      const ready = await fetch('http://127.0.0.1:' + record.port + '/ping', {
        signal: AbortSignal.timeout(1000),
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return record;
    }
    await delay(200);
  }
  throw new Error('Timed out waiting for the isolated Native Messaging host.');
}

async function loadExtension(child, path) {
  const send = child.stdio[3];
  const receive = child.stdio[4];
  let buffer = '';
  const replies = new Map();
  receive.setEncoding('utf8');
  receive.on('data', (chunk) => {
    buffer += chunk;
    let separator;
    while ((separator = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 1);
      replies.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = async (method, params) => {
    const requestId = ++id;
    const reply = new Promise((resolve) => replies.set(requestId, resolve));
    send.write(JSON.stringify({ id: requestId, method, params }) + '\0');
    const result = await Promise.race([
      reply,
      delay(8000).then(() => {
        throw new Error(method + ' timed out');
      }),
    ]);
    replies.delete(requestId);
    if (result.error) throw new Error(result.error.message);
    return result.result;
  };
  const version = await request('Browser.getVersion');
  const installed = await request('Extensions.loadUnpacked', { path });
  return { version: version.product, extensionId: installed.id };
}

try {
  if (process.platform === 'win32') {
    const existing = await exec('reg.exe', ['query', registration, '/ve']).then(
      ({ stdout }) => /REG_SZ\s+[^\r\n]+\.json\s*$/i.test(stdout.trim()),
      () => false,
    );
    if (existing) {
      const testHost = 'com.browserpaw.fixture_' + randomUUID().replaceAll('-', '');
      const portProbe = createServer();
      portProbe.listen(0, '127.0.0.1');
      await once(portProbe, 'listening');
      const testPort = portProbe.address().port;
      await new Promise((resolve) => portProbe.close(resolve));
      const isolated = join(root, 'package');
      await cp(dirname(cli), isolated, { recursive: true });
      cli = join(isolated, 'cli.cjs');
      for (const [file, defaultPort] of [
        [cli, 'DEFAULT_SERVER_PORT = 12307;'],
        [join(isolated, 'host.cjs'), 'DEFAULT_SERVER_PORT = 12307;'],
        [join(isolated, 'extension', 'background.js'), 'DEFAULT_PORT: 12307'],
      ]) {
        const source = await readFile(file, 'utf8');
        assert.ok(source.includes(defaultPort), 'Missing default port in test bundle.');
        await writeFile(
          file,
          source
            .replaceAll(productionHost, testHost)
            .replace(defaultPort, defaultPort.replace('12307', String(testPort))),
        );
      }
      env.BROWSERPAW_PORT = String(testPort);
      report.isolatedHostName = testHost;
      report.isolatedPort = testPort;
    }
  }
  registered = true;
  const setup = await run('setup', ['setup']);
  assert.equal(setup.skillScope, 'user');
  assert.ok(setup.skillPath.endsWith(join('.agents', 'skills', 'browserpaw')));
  const build = JSON.parse(await readFile(join(setup.extension, 'browserpaw-build.json'), 'utf8'));
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const url = 'http://127.0.0.1:' + fixture.address().port;
  await mkdir(join(root, 'profile', 'Default'), { recursive: true });
  await mkdir(join(root, 'downloads'));
  await writeFile(
    join(root, 'profile', 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: join(root, 'downloads'), prompt_for_download: false },
    }),
  );
  browser = spawn(
    chrome,
    [
      '--user-data-dir=' + join(root, 'profile'),
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-logging',
      '--log-file=' + join(root, 'chrome.log'),
      url + '/borrowed',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env, windowsHide: true },
  );
  browser.on('error', (error) => {
    report.browserError = error.message;
  });
  const loaded = await loadExtension(browser, setup.extension);
  assert.equal(loaded.extensionId, setup.extensionId);
  const firstHost = await waitForHost();
  report.chromeVersion = loaded.version;
  const status = await run('status', ['status']);
  assert.equal(status.pid, firstHost.pid);
  assert.equal(status.extension.buildId, build.buildId);
  report.buildId = status.extension.buildId;
  report.extensionVersion = status.extension.manifestVersion;
  const before = await run('initial-tabs', ['tabs']);
  const external = before.windows
    .flatMap((window) => window.tabs)
    .find((tab) => tab.url === url + '/borrowed');
  assert.ok(external?.tabId, 'Missing the Chrome-started fixture tab.');
  const start = await run('task-start', ['task', 'start', 'CLI acceptance']);
  const taskId = start.task.id;
  const task = (label, args, code) => run(label, [...args, '--task', taskId], code);
  const opened = await task('task-open', ['open', url]);
  const history = await run('history-search', ['history', 'search', url, '--since', '1h']);
  assert.ok(history.items.some((item) => item.url?.startsWith(url)));
  const top = await run('history-top', ['history', 'top', '--since', '1h']);
  assert.ok(top.domains.some((item) => item.domain === '127.0.0.1' && item.visits > 0));
  const folder = await run('bookmark-mkdir', ['bookmark', 'mkdir', 'BrowserPaw E2E']);
  const added = await run('bookmark-add', [
    'bookmark',
    'add',
    url,
    '--title',
    'BrowserPaw E2E link',
    '--folder',
    folder.id,
  ]);
  await run('bookmark-add-duplicate', ['bookmark', 'add', url, '--folder', folder.id]);
  const duplicates = await run('bookmark-dedupe-preview', [
    'bookmark',
    'dedupe',
    '--folder',
    folder.id,
  ]);
  assert.equal(duplicates.groups.length, 1);
  const deduped = await run('bookmark-dedupe-apply', [
    'bookmark',
    'dedupe',
    '--folder',
    folder.id,
    '--apply',
  ]);
  assert.equal(deduped.removed.length, 1);
  assert.equal(duplicates.groups[0].keep, added.bookmark.id);
  const subfolder = await run('bookmark-subfolder', [
    'bookmark',
    'mkdir',
    'Archive',
    '--folder',
    folder.id,
  ]);
  await run('bookmark-move', ['bookmark', 'mv', added.bookmark.id, '--folder', subfolder.id]);
  await run('bookmark-rename', [
    'bookmark',
    'rename',
    added.bookmark.id,
    'BrowserPaw E2E archived',
  ]);
  const found = await run('bookmark-search', ['bookmark', 'search', 'BrowserPaw E2E archived']);
  assert.equal(found.items[0].parentId, subfolder.id);
  const exported = await run('bookmark-export', [
    'bookmark',
    'export',
    '--out',
    join(root, 'bookmarks.html'),
    '--folder',
    folder.id,
    '--format',
    'html',
  ]);
  assert.match(
    await readFile(exported.outputPath, 'utf8'),
    /NETSCAPE-Bookmark-file-1[\s\S]*BrowserPaw E2E archived/,
  );
  await run('bookmark-cleanup', ['bookmark', 'rm', folder.id, '--recursive']);
  await task('storage-set', ['storage', 'set', 'browserpaw-fixture', 'ready']);
  const stored = await task('storage-get', ['storage', 'get', 'browserpaw-fixture']);
  assert.equal(stored.value, 'ready');
  await task('storage-rm', ['storage', 'rm', 'browserpaw-fixture']);
  await run('cookie-set', ['cookies', 'set', url, 'browserpaw_fixture', 'ready']);
  const cookies = await run('cookies-list', ['cookies', 'list', '--url', url]);
  const cookie = cookies.items.find((item) => item.name === 'browserpaw_fixture');
  assert.ok(cookie && !Object.hasOwn(cookie, 'value'));
  await run('cookie-rm', ['cookies', 'rm', url, 'browserpaw_fixture']);
  const tabsByTitle = await run('tabs-search', ['tabs', 'BrowserPaw test', '--limit', '10']);
  assert.ok(tabsByTitle.tabs.some((item) => item.tabId === opened.tabId));
  const tabsByContent = await run('tabs-content-search', ['tabs', 'Public name', '--content']);
  assert.ok(tabsByContent.tabs.some((item) => item.tabId === opened.tabId && item.snippet));
  const separate = await run('window-open', ['window', 'open', url + '/window', '--background']);
  assert.ok(separate.tabId && separate.windowId && separate.created);
  const windowList = await run('window-list', ['window', 'list']);
  assert.ok(windowList.windows.some((item) => item.windowId === separate.windowId));
  const grouped = await run('group-create', [
    'group',
    'create',
    String(separate.tabId),
    '--title',
    'Fixture',
  ]);
  await run('group-list', ['group', 'list', '--window', String(separate.windowId)]);
  await run('group-ungroup', ['group', 'ungroup', String(separate.tabId)]);
  assert.ok(grouped.group.id);
  assert.equal(grouped.group.windowId, separate.windowId);
  await run('window-close', ['window', 'close', String(separate.windowId)]);
  const links = await task('text-links', ['text', '--links']);
  assert.ok(links.links.some((link) => link.url === url + '/file'));
  const scrolled = await task('scroll-until', ['scroll', '--selector', '#reveal', '--max', '2']);
  assert.equal(scrolled.found, true);
  const metrics = await task('performance-metrics', ['perf', 'metrics']);
  assert.ok(metrics.metrics && Object.keys(metrics.metrics).length > 0);
  await task('perf-trace-start', ['perf', 'trace', 'start']);
  await task('perf-trace-activity', ['eval', 'document.title']);
  const trace = await task('perf-trace-stop', [
    'perf',
    'trace',
    'stop',
    '--out',
    join(root, 'trace.json'),
  ]);
  assert.ok(JSON.parse(await readFile(trace.outputPath, 'utf8')));
  await task('network-body-start', ['network', 'start', '--bodies', '--filter', '/debug-json']);
  await task('network-body-request', ['eval', 'fetch("/debug-json").then(r => r.json())']);
  await delay(400);
  const captured = await task('network-body-list', ['network', 'list', '--status', '200']);
  const request = captured.requests.find((entry) => entry.url === url + '/debug-json');
  assert.ok(request, 'Expected a captured fixture response.');
  const responseBody = await task('network-body-export', [
    'network',
    'show',
    String(request.id),
    '--out',
    join(root, 'response.json'),
  ]);
  assert.equal(
    JSON.parse(await readFile(responseBody.outputPath, 'utf8')).fixture,
    'native-response',
  );
  await task('network-body-stop', ['network', 'stop']);
  await task('emulate-viewport', ['emulate', '--viewport', '420x700']);
  const viewport = await task('emulate-read-width', ['eval', 'innerWidth']);
  assert.equal(Number(viewport.result), 420);
  await task('emulate-reset', ['emulate', 'reset']);
  const pdf = await task('print-pdf', ['pdf', '--out', join(root, 'page.pdf')]);
  assert.equal((await readFile(pdf.outputPath)).subarray(0, 4).toString(), '%PDF');
  const ownedTabId = opened.task.currentTabId;
  let observed = await task('observe', ['observe']);
  const lookup = (label) => {
    const rows = observed.treeString.split('\n').filter((line) => line.includes(label));
    const match = rows.map((line) => /^\s*\[(\d+)\]/.exec(line)).find(Boolean);
    assert.ok(match, `Missing ref for ${label}`);
    return match[1];
  };
  await task('fill-label', ['fill', 'label:Public name', '示例']);
  await task('fill-rich', ['fill', 'css:#editor', 'Line one\n第二行']);
  await task('select', ['select', 'css:#choice', 'two']);
  observed = await task('observe-colors', ['observe']);
  await task('multi-select', ['select', lookup('#colors'), 'blue', 'red']);
  await task('click-ref', ['click', lookup('Reveal')]);
  await task('wait', ['wait', '--text', 'Dynamic result']);
  const values = await task('verify-form', [
    'eval',
    '({name:document.querySelector("#name").value, editor:document.querySelector("#editor").innerText, choice:document.querySelector("#choice").value})',
  ]);
  assert.match(JSON.stringify(values), /示例/);
  assert.match(JSON.stringify(values), /第二行/);
  assert.equal(JSON.parse(values.result).choice, 'two');
  const frame = await task('frame-inventory', [
    'eval',
    'document.querySelector("iframe").contentDocument.querySelector("#inner").id',
  ]);
  assert.match(JSON.stringify(frame), /inner/);
  observed = await task('frame-observe', ['observe']);
  const frameId = /Frame input[^\n]*frame="(\d+)"/.exec(observed.treeString)?.[1];
  assert.ok(frameId, 'Missing child frame identity.');
  await task('frame-fill', ['fill', lookup('Frame input'), '--frame', frameId, 'Child frame']);
  const frameValue = await task('frame-verify', [
    'eval',
    'document.querySelector("iframe").contentDocument.querySelector("#inner").value',
  ]);
  assert.match(JSON.stringify(frameValue), /Child frame/);
  const upload = join(root, 'upload.txt');
  await writeFile(upload, 'fixture upload');
  await task('upload', ['upload', 'css:#upload', upload]);
  const uploaded = await task('verify-upload', [
    'eval',
    'document.querySelector("#upload").files[0].name',
  ]);
  assert.match(JSON.stringify(uploaded), /upload.txt/);
  await task('network-start', ['network', 'start']);
  await task('fetch', ['fetch', url + '/frame']);
  await task('network-show', ['network', 'show']);
  await task('network-stop', ['network', 'stop']);
  await task('console', ['console']);
  const batch = join(root, 'batch.json');
  await writeFile(
    batch,
    JSON.stringify([
      ['fill', 'css:#name', 'Batch changed'],
      ['text', 'css:#reveal'],
    ]),
  );
  await task('batch', ['batch', batch]);
  const recipe = join(root, 'recipe.json');
  await writeFile(
    recipe,
    JSON.stringify({
      id: 'test-fixture',
      name: 'Fixture Reveal Reader',
      description: 'Read reveal button text from the local test fixture',
      keywords: ['fixture', 'reveal'],
      steps: [['text', 'css:#reveal']],
    }),
  );
  await task('recipe-save', ['recipe', 'save', recipe]);
  const foundRecipe = await run('recipe-find', ['recipe', 'find', 'reveal']);
  assert.equal(foundRecipe.matches[0].id, 'test-fixture');
  const syncedSkill = await readFile(join(setup.skillPath, 'SKILL.md'), 'utf8');
  assert.match(syncedSkill, /test-fixture/);
  assert.match(syncedSkill, /browserpaw recipe run test-fixture/);
  await task('recipe-run', ['recipe', 'run', 'test-fixture']);
  await task('recipe-remove', ['recipe', 'rm', 'test-fixture']);
  const clearedSkill = await readFile(join(setup.skillPath, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(clearedSkill, /test-fixture/);
  const screenshot = join(output, `screenshot-${build.buildId}.png`);
  const position = await task('coordinate-target', [
    'eval',
    '({x:document.querySelector("#reveal").getBoundingClientRect().left+5,y:document.querySelector("#reveal").getBoundingClientRect().top+5})',
  ]);
  const image = await task('screenshot', ['screenshot', '--out', screenshot]);
  const png = await readFile(screenshot);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.format, 'png');
  assert.ok(image.captureId);
  const point = JSON.parse(position.result);
  const x = Math.round((point.x - image.originX) * image.scaleFactor);
  const y = Math.round((point.y - image.originY) * image.scaleFactor);
  await task('coordinate-click', ['click', `@${x},${y}`, '--capture', image.captureId]);
  observed = await task('observe-download', ['observe']);
  const scoped = await task('download-scoped', ['download', lookup('Download fixture')]);
  assert.equal(scoped.browserCompleted, true);
  assert.ok(scoped.download.guid);
  const downloaded = await task('download-file', [
    'download',
    '--url',
    url + '/file',
    '--out',
    join(output, build.buildId),
  ]);
  assert.equal(await readFile(downloaded.filePath, 'utf8'), 'browserpaw fixture download');
  await task('task-borrow', ['task', 'borrow', String(external.tabId)]);
  await task('task-finish', ['task', 'finish']);
  const inventory = await run('tabs-after-finish', ['tabs']);
  assert.ok(
    inventory.windows.some((window) => window.tabs.some((tab) => tab.tabId === external.tabId)),
  );
  assert.ok(
    inventory.windows.every((window) => window.tabs.every((tab) => tab.tabId !== ownedTabId)),
  );
  const interruptedTab = await run('open-for-disconnect', ['open', url]);
  const tab = ['--tab', String(interruptedTab.tabId)];
  await run('dialog-trigger', ['click', 'css:#dialog', ...tab], [0, 1, 4]);
  await run('dialog-accept', ['dialog', 'accept', ...tab]);
  const interrupted = run(
    'dispatch-outcome-unknown',
    [
      'eval',
      'await fetch("/dispatch-marker",{method:"POST"}); await new Promise(resolve=>setTimeout(resolve,5000)); true',
      ...tab,
    ],
    4,
  );
  await Promise.race([
    dispatchStarted,
    delay(10000).then(() => {
      throw new Error('Action was not dispatched');
    }),
  ]);
  process.kill(firstHost.pid);
  assert.equal((await interrupted).outcome, 'unknown');
  const restarted = await waitForHost(firstHost.pid);
  const afterRestart = await run('status-after-reconnect', ['status']);
  assert.equal(afterRestart.pid, restarted.pid);
  assert.equal(dispatched, 1);
  await run('close-after-reconnect', ['tab', 'close', String(interruptedTab.tabId)]);
  const extensionFile = join(setup.extension, 'browserpaw-build.json');
  const extensionBefore = await readFile(extensionFile, 'utf8');
  const markerFile = join(setup.skillPath, '.browserpaw-skill.json');
  const marker = JSON.parse(await readFile(markerFile, 'utf8'));
  await writeFile(markerFile, JSON.stringify({ ...marker, version: '4.99.0' }));
  const upgrade = await run('setup-updates-skill', ['setup']);
  assert.equal(upgrade.extensionPrepared, false);
  assert.deepEqual(upgrade.updatedSkillPaths, [setup.skillPath]);
  assert.equal(JSON.parse(await readFile(markerFile, 'utf8')).version, marker.version);
  assert.equal(await readFile(extensionFile, 'utf8'), extensionBefore);
  assert.match(upgrade.releaseAsset, /browserpaw-extension\.zip$/);
  const statusAfterSetup = await run('setup-leaves-loaded-extension-running', ['status']);
  assert.equal(statusAfterSetup.pid, restarted.pid);
  assert.equal(statusAfterSetup.extension.buildId, build.buildId);
  await run('unowned-close', ['tab', 'close', String(external.tabId)]);
  report.status = 'passed';
} finally {
  fixture.close();
  fixture.closeAllConnections();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await Promise.race([once(browser, 'exit'), delay(3500)]);
  }
  if (registered)
    await run('uninstall', ['uninstall']).catch((error) => {
      report.cleanupError = error.message;
    });
  const diagnostics = await readFile(join(env.BROWSERPAW_HOME, 'logs', 'host.log'), 'utf8').catch(
    () => '',
  );
  if (diagnostics) await writeFile(join(output, 'host.log'), diagnostics);
  if (report.status !== 'passed') {
    const chromeLog = await readFile(join(root, 'chrome.log'), 'utf8').catch(() => '');
    if (chromeLog) await writeFile(join(output, 'chrome.log'), chromeLog);
  }
  await writeFile(join(output, 'runtime-report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    (error) => {
      console.error(`Could not remove isolated test state ${root}: ${error.message}`);
    },
  );
}
