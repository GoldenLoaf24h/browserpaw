import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isNewerVersion } from 'chrome-mcp-shared';

export interface SkillInstallOptions {
  scope?: string;
  targetRoot?: string;
  cwd?: string;
  force?: boolean;
  sourceDir?: string;
  version?: string;
}

export type InstalledSkillScope = 'user' | 'project' | 'custom';

export interface SkillInstallResult {
  installedPath: string;
  version: string;
  scope: InstalledSkillScope;
}

export interface LearnedRoutingEntry {
  id: string;
  kind: 'skill' | 'recipe';
  name: string;
  description: string;
  domains: string[];
  command: string;
}

const markerName = '.browserpaw-skill.json';
const skillName = 'browserpaw';
const learnedStartMarker = '<!-- browserpaw:learned:start -->';
const learnedEndMarker = '<!-- browserpaw:learned:end -->';
const learnedDescriptionPrefix = ' Learned workflows ready: ';

function assertNoLinks(target: string): void {
  let current = path.resolve(target);
  while (true) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing symlink or junction in target path: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertPlainTree(root: string): void {
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Bundled skill contains a symlink: ${full}`);
      if (stat.isDirectory()) visit(full);
      else if (!stat.isFile()) throw new Error(`Unsupported bundled skill entry: ${full}`);
    }
  };
  visit(root);
}

function assertSkillSource(root: string): void {
  const skillFile = path.join(root, 'SKILL.md');
  if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
    throw new Error(`Packaged BrowserPaw skill is missing SKILL.md: ${root}`);
  }
  const frontmatter = fs.readFileSync(skillFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter || !/^name:\s*browserpaw\s*$/m.test(frontmatter)) {
    throw new Error('Packaged skill must declare name: browserpaw');
  }
  assertPlainTree(root);
}

function readMarker(
  directory: string,
): (Partial<SkillInstallResult> & { name?: string; baseDescription?: string }) | null {
  const marker = path.join(directory, markerName);
  if (!fs.existsSync(marker)) return null;
  try {
    assertNoLinks(marker);
    return JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    return null;
  }
}

function extractFrontmatterDescription(markdown: string): string {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return '';
  const raw = frontmatter.match(/^description:\s*(.+)\s*$/m)?.[1]?.trim() ?? '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\"/g, '"').trim();
  }
  return raw;
}

function cleanInlineText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeMarkdownCell(value: string): string {
  return cleanInlineText(value).replace(/\|/g, '\\|');
}

function formatFrontmatterDescription(
  base: string,
  entries: readonly LearnedRoutingEntry[],
): string {
  const normalizedBase = cleanInlineText(base).split(learnedDescriptionPrefix)[0].trim();
  if (!entries.length) return normalizedBase;
  const maxTotalChars = 480;
  const parts: string[] = [];
  let length = normalizedBase.length + learnedDescriptionPrefix.length;
  for (const entry of entries.slice(0, 8)) {
    const sites = entry.domains.slice(0, 2).join('/');
    const token = sites ? `${entry.id} (${sites})` : entry.id;
    const nextLength = length + (parts.length ? 2 : 0) + token.length;
    if (parts.length > 0 && nextLength > maxTotalChars) break;
    parts.push(token);
    length = nextLength;
  }
  if (!parts.length) return normalizedBase;
  const suffix = entries.length > parts.length ? `, and ${entries.length - parts.length} more` : '';
  return `${normalizedBase}${learnedDescriptionPrefix}${parts.join(', ')}${suffix}.`;
}

function renderLearnedSection(entries: readonly LearnedRoutingEntry[]): string {
  if (!entries.length) return '';
  const visible = entries.slice(0, 20);
  const rows = visible.map((entry) => {
    const sites = entry.domains.length
      ? entry.domains
          .slice(0, 3)
          .map((d) => `\`${d}\``)
          .join(', ')
      : '-';
    const summary = escapeMarkdownCell(entry.description || entry.name).slice(0, 110);
    const cmd = escapeMarkdownCell(entry.command);
    return `| \`${entry.id}\` | ${entry.kind} | ${sites} | ${summary} | \`${cmd}\` |`;
  });
  const overflow =
    entries.length > visible.length
      ? `\n\nRun \`browserpaw recipe find <query>\` to search all ${entries.length} learned workflows in \`~/.browserpaw\`.`
      : '';
  return [
    learnedStartMarker,
    '## Learned Workflows (`~/.browserpaw`)',
    '',
    'Auto-synced from `~/.browserpaw`. Match and call these directly with `browserpaw recipe run` before manually browsing:',
    '',
    '| ID | Type | Sites | Summary | CLI Command |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    ...(overflow ? [overflow] : []),
    learnedEndMarker,
  ].join('\n');
}

function packageVersion(): string {
  return String(require('../package.json').version);
}

export function defaultSkillTargetRoot(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

export function projectSkillTargetRoot(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.agents', 'skills');
}

export function resolveSkillTargetRoot(
  options: {
    scope?: string;
    targetRoot?: string;
    cwd?: string;
  } = {},
): { targetRoot: string; scope: InstalledSkillScope } {
  if (options.scope && options.targetRoot) {
    throw new Error('Use either --skill-scope or --skill-dir, not both.');
  }
  if (options.targetRoot) {
    return { targetRoot: path.resolve(options.targetRoot), scope: 'custom' };
  }
  const normalized = (options.scope ?? 'user').toLowerCase();
  if (normalized === 'user' || normalized === 'global') {
    return { targetRoot: defaultSkillTargetRoot(), scope: 'user' };
  }
  if (normalized === 'project') {
    return { targetRoot: projectSkillTargetRoot(options.cwd), scope: 'project' };
  }
  throw new Error('Use --skill-scope user or project.');
}

export function installSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const sourceDir = path.resolve(options.sourceDir ?? path.join(__dirname, 'skill', skillName));
  const version = options.version ?? packageVersion();
  const resolved = resolveSkillTargetRoot({
    scope: options.scope,
    targetRoot: options.targetRoot,
    cwd: options.cwd,
  });
  const targetRoot = resolved.targetRoot;
  const destination = path.join(targetRoot, skillName);
  let scope = resolved.scope;
  assertNoLinks(targetRoot);
  assertNoLinks(destination);
  assertSkillSource(sourceDir);
  const baseDescription = extractFrontmatterDescription(
    fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8'),
  );

  if (fs.existsSync(destination)) {
    const marker = readMarker(destination);
    if (!marker || marker.name !== skillName) {
      throw new Error(
        `Refusing to replace ${destination}: it has no BrowserPaw installation marker`,
      );
    }
    if (!options.force) {
      throw new Error(
        `BrowserPaw skill already exists at ${destination}; use --force to replace it`,
      );
    }
    if (options.targetRoot && (marker.scope === 'user' || marker.scope === 'project')) {
      scope = marker.scope;
    }
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  assertNoLinks(targetRoot);
  const staging = path.join(targetRoot, `.${skillName}-staging-${randomUUID()}`);
  const backup = path.join(targetRoot, `.${skillName}-backup-${randomUUID()}`);
  try {
    fs.mkdirSync(staging, { recursive: false });
    fs.cpSync(sourceDir, staging, { recursive: true, dereference: false });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  try {
    fs.writeFileSync(
      path.join(staging, markerName),
      `${JSON.stringify(
        {
          name: skillName,
          version,
          scope,
          source: 'bundled:skills/browserpaw',
          baseDescription,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const existed = fs.existsSync(destination);
  if (existed) {
    try {
      fs.renameSync(destination, backup);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (existed && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, destination);
      } catch {
        // Preserve the backup if restoration is not possible rather than deleting the old install.
      }
    }
    throw error;
  }
  try {
    fs.rmSync(backup, { recursive: true, force: true });
  } catch {
    // A leftover backup is safer than failing a completed install.
  }
  return { installedPath: destination, version, scope };
}

export function upgradeInstalledSkill(
  installedPath: string,
  options: Pick<SkillInstallOptions, 'sourceDir' | 'version'>,
): SkillInstallResult | undefined {
  if (path.basename(installedPath) !== skillName || !fs.existsSync(installedPath)) return;
  assertNoLinks(installedPath);
  const marker = readMarker(installedPath);
  const version = options.version ?? packageVersion();
  if (marker?.name !== skillName || (marker.version && !isNewerVersion(version, marker.version)))
    return;
  return installSkill({
    ...options,
    version,
    targetRoot: path.dirname(installedPath),
    force: true,
  });
}

export function syncInstalledSkillRouting(
  installedSkillDir: string,
  entries: readonly LearnedRoutingEntry[],
): boolean {
  const targetDir = path.resolve(installedSkillDir);
  if (!fs.existsSync(targetDir)) return false;
  assertNoLinks(targetDir);
  const marker = readMarker(targetDir);
  if (!marker || marker.name !== skillName) return false;
  const skillFile = path.join(targetDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return false;
  assertNoLinks(skillFile);

  const current = fs.readFileSync(skillFile, 'utf8');
  const frontmatterMatch = current.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!frontmatterMatch) return false;

  const baseDescription = marker.baseDescription?.trim() || extractFrontmatterDescription(current);
  const nextDescription = formatFrontmatterDescription(baseDescription, entries);
  const yamlDescription = `description: ${JSON.stringify(nextDescription)}`;
  const updatedFrontmatter = /^description:\s*.*$/m.test(frontmatterMatch[2])
    ? frontmatterMatch[2].replace(/^description:\s*.*$/m, yamlDescription)
    : `${frontmatterMatch[2]}\n${yamlDescription}`;

  let updated = `${frontmatterMatch[1]}${updatedFrontmatter}${frontmatterMatch[3]}${current.slice(
    frontmatterMatch[0].length,
  )}`;

  const starts = [...updated.matchAll(new RegExp(learnedStartMarker, 'g'))];
  const ends = [...updated.matchAll(new RegExp(learnedEndMarker, 'g'))];
  if (
    starts.length + ends.length > 0 &&
    (starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].index === undefined ||
      ends[0].index === undefined ||
      starts[0].index > ends[0].index)
  ) {
    const error = new Error(
      `Malformed BrowserPaw Learned Workflows markers in ${skillFile}. Keep at most one start marker followed by one end marker, then run setup again.`,
    ) as NodeJS.ErrnoException;
    error.code = 'ERR_BROWSERPAW_SKILL_MARKERS';
    throw error;
  }
  const blockPattern = new RegExp(
    `\\r?\\n?${learnedStartMarker}[\\s\\S]*?${learnedEndMarker}`,
    'm',
  );
  const section = renderLearnedSection(entries);
  if (blockPattern.test(updated)) {
    updated = updated.replace(blockPattern, section ? `\n${section}` : '');
  } else if (section) {
    updated = `${updated.trimEnd()}\n\n${section}\n`;
  }
  if (!updated.endsWith('\n')) updated += '\n';
  if (updated === current) return true;

  const temporary = path.join(targetDir, `.SKILL.md.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, skillFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}
