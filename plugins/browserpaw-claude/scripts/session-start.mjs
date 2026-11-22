import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_WORKFLOWS = 30;

export function resolveBrowserPawHome(env = process.env) {
  return path.resolve(env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw'));
}

export function findBrowserPawCli(env = process.env, platform = process.platform) {
  const candidates =
    platform === 'win32' ? ['browserpaw.cmd', 'browserpaw.exe', 'browserpaw'] : ['browserpaw'];
  const searchDirs = [];

  if (env.CLAUDE_PLUGIN_ROOT) {
    searchDirs.push(path.join(env.CLAUDE_PLUGIN_ROOT, 'node_modules', '.bin'));
  }
  if (env.CLAUDE_PLUGIN_DATA) {
    searchDirs.push(path.join(env.CLAUDE_PLUGIN_DATA, 'node_modules', '.bin'));
  }
  const rawPath = env.PATH || env.Path || '';
  for (const dir of rawPath.split(path.delimiter)) {
    if (dir && dir.trim()) searchDirs.push(dir.trim());
  }

  for (const dir of searchDirs) {
    for (const bin of candidates) {
      const full = path.join(dir, bin);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

export function readLearnedWorkflows(homeDir = resolveBrowserPawHome()) {
  const indexPath = path.join(homeDir, 'learned-index.json');
  try {
    const stat = fs.lstatSync(indexPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INDEX_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.workflows)) return [];
    return parsed.workflows
      .filter(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          (!item.status || item.status === 'active' || item.status === 'bundled'),
      )
      .slice(0, MAX_WORKFLOWS)
      .map((item) => ({
        id: item.id,
        domains: Array.isArray(item.domains)
          ? item.domains.filter((d) => typeof d === 'string')
          : [],
        command:
          typeof item.command === 'string' ? item.command : `browserpaw recipe run ${item.id}`,
      }));
  } catch {
    return [];
  }
}

export function buildSessionContext(env = process.env, platform = process.platform) {
  const homeDir = resolveBrowserPawHome(env);
  const cliPath = findBrowserPawCli(env, platform);
  const workflows = readLearnedWorkflows(homeDir);
  const lines = [];

  if (cliPath) {
    lines.push(`BrowserPaw CLI is available at ${cliPath}.`);
  } else {
    lines.push(
      'BrowserPaw CLI (`browserpaw`) was not found on PATH. Install with `npm install -g browserpaw@5.0.0 && browserpaw setup --no-skill` (or use `npx --yes browserpaw@5.0.0`) and load the Chrome extension.',
    );
  }

  if (workflows.length > 0) {
    const summary = workflows
      .map((wf) => {
        const domainTag = wf.domains.length ? ` [${wf.domains.join(', ')}]` : '';
        return `- ${wf.id}${domainTag}: \`${wf.command}\``;
      })
      .join('\n');
    lines.push(`Active BrowserPaw learned workflows in ${homeDir}:\n${summary}`);
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(buildSessionContext())}\n`);
  } catch {
    // Never block session startup on diagnostics errors.
  }
}
