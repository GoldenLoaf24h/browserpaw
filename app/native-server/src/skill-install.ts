import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SkillInstallOptions {
  targetRoot?: string;
  force?: boolean;
  sourceDir?: string;
  version?: string;
}

export interface SkillInstallResult {
  installedPath: string;
  version: string;
}

const markerName = '.browserpaw-skill.json';
const skillName = 'browserpaw';

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

function readMarker(directory: string): { name?: string } | null {
  const marker = path.join(directory, markerName);
  if (!fs.existsSync(marker)) return null;
  try {
    return JSON.parse(fs.readFileSync(marker, 'utf8')) as { name?: string };
  } catch {
    return null;
  }
}

function packageVersion(): string {
  return String(require('../package.json').version);
}

export function defaultSkillTargetRoot(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

export function installSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const sourceDir = path.resolve(options.sourceDir ?? path.join(__dirname, 'skill', skillName));
  const version = options.version ?? packageVersion();
  const targetRoot = path.resolve(options.targetRoot ?? defaultSkillTargetRoot());
  const destination = path.join(targetRoot, skillName);
  assertNoLinks(targetRoot);
  assertNoLinks(destination);
  assertSkillSource(sourceDir);

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
          source: 'bundled:skills/browserpaw',
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
  return { installedPath: destination, version };
}
