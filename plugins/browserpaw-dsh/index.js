import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'browserpaw';
const DEFAULT_DESCRIPTION =
  "Control the user's Chrome or Chromium through the BrowserPaw CLI and run learned site workflows stored in ~/.browserpaw.";
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_ROUTING_ROWS = 20;

export const name = 'browserpaw-skill';
export const inject = ['skills'];

export function resolveBrowserPawHome(env = process.env) {
  return path.resolve(env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw'));
}

export function resolveBundledCliBin(fromUrl = import.meta.url) {
  try {
    const req = createRequire(fromUrl);
    const pkgPath = req.resolve('browserpaw/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.browserpaw;
    if (!relBin || typeof relBin !== 'string') return null;
    const resolved = path.resolve(path.dirname(pkgPath), relBin);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
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
        (item) => item && typeof item.id === 'string' && (!item.status || item.status === 'active'),
      )
      .slice(0, MAX_ROUTING_ROWS)
      .map((item) => ({
        id: item.id,
        domains: Array.isArray(item.domains)
          ? item.domains.filter((d) => typeof d === 'string')
          : [],
        command:
          typeof item.command === 'string' ? item.command : `browserpaw recipe run ${item.id}`,
        description: typeof item.description === 'string' ? item.description : '',
      }));
  } catch {
    return [];
  }
}

function parseSkillDescription(markdown) {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1];
  if (!fm) return DEFAULT_DESCRIPTION;
  const line = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!line) return DEFAULT_DESCRIPTION;
  if (
    (line.startsWith('"') && line.endsWith('"')) ||
    (line.startsWith("'") && line.endsWith("'"))
  ) {
    try {
      return JSON.parse(line);
    } catch {
      return line.slice(1, -1);
    }
  }
  return line;
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

export function buildRuntimeNote({ bundledCliPath = null, homeDir = '~/.browserpaw' } = {}) {
  const lines = [
    '> **DeepSeek Harness Integration**: This read-only base skill is bundled inside the `dsh-browserpaw` plugin directory. Evolving self-learned site workflows live separately under `' +
      homeDir +
      '` (`skills/`, `recipes/`, `learned-index.json`) and never conflict with this base skill. Run `browserpaw recipe find` for live discovery; newly saved workflows appear in the static table below after restarting the DSH profile.',
  ];
  if (bundledCliPath) {
    lines.push(
      `> **Bundled CLI**: Invoke the plugin-bundled CLI via \`node "${bundledCliPath}"\` (avoiding stale global \`PATH\` installs), or fall back to \`browserpaw\` on \`PATH\` if needed. For first-time setup run \`node "${bundledCliPath}" setup --no-skill\` (or \`dsh plugin --profile web exec browserpaw setup --no-skill\`) and load the printed Chrome extension directory.`,
    );
  } else {
    lines.push(
      '> **CLI Prerequisite**: Run `browserpaw status` to verify the host and Chrome extension. If `browserpaw` is not on `PATH`, install with `npm install -g browserpaw@5.0.0 && browserpaw setup --no-skill`.',
    );
  }
  return lines.join('\n');
}

export function buildLearnedWorkflowsSection(workflows = []) {
  if (!workflows.length) return '';
  const lines = [
    '## Active Learned Workflows (`~/.browserpaw`)',
    '',
    '| Workflow | Domains | Command | Summary |',
    '| :--- | :--- | :--- | :--- |',
  ];
  for (const wf of workflows) {
    lines.push(
      `| \`${escapeCell(wf.id)}\` | ${escapeCell(wf.domains.join(', ')) || '-'} | \`${escapeCell(wf.command)}\` | ${escapeCell(wf.description)} |`,
    );
  }
  return lines.join('\n');
}

export function apply(ctx) {
  const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = path.join(pkgRoot, 'skills', SKILL_NAME);
  const skillContent = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const description = parseSkillDescription(skillContent);
  const skillBody = stripFrontmatter(skillContent);
  const homeDir = resolveBrowserPawHome();
  const bundledCliPath = resolveBundledCliBin();
  const workflows = readLearnedWorkflows(homeDir);
  const runtimeNote = buildRuntimeNote({ bundledCliPath, homeDir });
  const workflowsSection = buildLearnedWorkflowsSection(workflows);
  const content = [runtimeNote, skillBody.trimEnd(), workflowsSection].filter(Boolean).join('\n\n');

  ctx.skills.register({
    name: SKILL_NAME,
    description,
    content,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: skillDir },
  });
}
