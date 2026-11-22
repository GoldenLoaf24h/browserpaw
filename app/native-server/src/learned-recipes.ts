import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCommand } from 'chrome-mcp-shared';
import { assertBatchStep } from './command-utils';
import {
  DOM_EXTRACTION_PROGRAM_ALIAS,
  PUBLISHED_READ_ONLY_PROGRAMS,
  programHash,
} from './skill-read-program';
import { syncInstalledSkillRouting, type LearnedRoutingEntry } from './skill-install';

export type RecipeInputType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

export interface RecipeInputSpec {
  type?: RecipeInputType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface SavedRecipe {
  id: string;
  status?: 'active' | 'candidate';
  name?: string;
  description?: string;
  domains?: string[];
  keywords?: string[];
  inputs?: Record<string, RecipeInputSpec>;
  notes?: string;
  sourceUrls?: string[];
  steps: string[][];
  updatedAt?: string;
}

export interface LearnedWorkflowSummary {
  id: string;
  kind: 'skill' | 'recipe';
  status: 'active' | 'bundled' | 'candidate';
  name: string;
  description: string;
  domains: string[];
  keywords: string[];
  inputs: Record<string, RecipeInputSpec>;
  notes?: string;
  command: string;
  sourcePath: string;
}

export interface MatchedWorkflow extends LearnedWorkflowSummary {
  score: number;
}

export interface RoutingSyncResult {
  indexPath: string;
  workflowCount: number;
  syncedSkillPaths: string[];
}

const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z0-9_-]+)\}\}/g;
const INPUT_TYPES = new Set<RecipeInputType>([
  'string',
  'integer',
  'number',
  'boolean',
  'object',
  'array',
]);
const READ_ONLY_SKILL_TOOLS = new Set([
  'chrome_javascript',
  'chrome_network_request',
  'chrome_read_dom',
  'chrome_get_markdown',
  'chrome_grep',
  'chrome_screenshot',
]);

function isTrustedBundledReadOnlySkill(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const def = raw as {
    id?: unknown;
    source?: { type?: unknown };
    steps?: Array<{ tool?: unknown; args?: Record<string, unknown> }>;
  };
  if (typeof def.id !== 'string' || def.source?.type !== 'builtin') return false;
  if (!Array.isArray(def.steps) || def.steps.length < 1 || def.steps.length > 20) return false;
  for (const step of def.steps) {
    if (!step || typeof step !== 'object' || typeof step.tool !== 'string') return false;
    if (!READ_ONLY_SKILL_TOOLS.has(step.tool)) return false;
    if (step.tool === 'chrome_javascript') {
      const args = step.args;
      if (!args || typeof args !== 'object') return false;
      const hasProgram = args.program !== undefined;
      const hasCode = typeof args.code === 'string';
      if (hasProgram && hasCode) return false;
      if (hasProgram) {
        if (args.program !== DOM_EXTRACTION_PROGRAM_ALIAS) return false;
        continue;
      }
      if (!hasCode) return false;
      const expectedHash = PUBLISHED_READ_ONLY_PROGRAMS[def.id];
      if (!expectedHash || programHash(args.code as string) !== expectedHash) return false;
    }
  }
  return true;
}
const TARGET_ARGUMENTS = new Map<string, readonly number[]>([
  ['text', [0]],
  ['screenshot', [0]],
  ['wait', [0]],
  ['click', [0]],
  ['hover', [0]],
  ['fill', [0]],
  ['select', [0]],
  ['press', [1]],
  ['scroll', [0]],
  ['drag', [0, 1]],
  ['upload', [0]],
  ['download', [0]],
]);

const QUERY_ALIASES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/推特|推文|twitter/i, ['twitter', 'x', 'x.com', 'twitter.com']],
  [/搜索|查找|搜一下|搜一搜|检索/i, ['search', 'find', 'query']],
  [/帖子|动态|话题|讨论|串|thread/i, ['posts', 'thread', 'status', 'topic']],
  [/版本|发布|发行版|更新日志/i, ['releases', 'release', 'version']],
  [/文档|手册|参考/i, ['docs', 'documentation', 'reference', 'mdn']],
  [/对比|比较/i, ['compare', 'comparison']],
  [/包|依赖|npm/i, ['npm', 'package']],
  [/下载/i, ['download']],
  [/仓库|代码库|开源|项目/i, ['github', 'repo', 'repository', 'repositories']],
  [/readme|项目说明|简介/i, ['readme', 'overview', 'repo']],
  [/议题|工单|issue|pr/i, ['issue', 'issues', 'pr', 'comments']],
  [/v2ex|v站/i, ['v2ex', 'www.v2ex.com', 'topics']],
  [/b站|哔哩哔哩|bilibili|bv号/i, ['bilibili', 'www.bilibili.com', 'video', 'bvid']],
  [/油管|youtube|ytb/i, ['youtube', 'www.youtube.com', 'video']],
  [/字幕|台词|文稿/i, ['subtitles', 'captions', 'transcript', 'subtitle']],
  [/视频/i, ['video', 'videos']],
  [/热门|热榜|趋势|流行/i, ['popular', 'hot', 'trending']],
  [/红迪|reddit|板块/i, ['reddit', 'www.reddit.com', 'subreddit']],
  [/评论|回复/i, ['comments', 'replies']],
  [/主页|资料|用户/i, ['profile', 'user', 'tweets']],
  [/节点/i, ['node', 'topics']],
];

export function browserPawHome(override?: string): string {
  return path.resolve(
    override || process.env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw'),
  );
}

export function recipesDirectory(homeDir = browserPawHome()): string {
  return path.join(homeDir, 'recipes');
}

export function skillsDirectory(homeDir = browserPawHome()): string {
  return path.join(homeDir, 'skills');
}

export function savedRecipeFilePath(id: unknown, homeDir = browserPawHome()): string {
  if (typeof id !== 'string' || !RECIPE_ID_PATTERN.test(id)) {
    throw new Error(
      'Recipe ID must begin with a lowercase letter and contain only letters, digits, or hyphens.',
    );
  }
  return path.join(recipesDirectory(homeDir), `${id}.json`);
}

export function candidateRecipeFilePath(id: unknown, homeDir = browserPawHome()): string {
  if (typeof id !== 'string' || !RECIPE_ID_PATTERN.test(id)) {
    throw new Error(
      'Recipe ID must begin with a lowercase letter and contain only letters, digits, or hyphens.',
    );
  }
  return path.join(recipesDirectory(homeDir), `${id}.candidate.json`);
}

export function domainMatchesHost(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  if (!host || !normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function assertNoStoredCredentials(value: unknown): void {
  if (typeof value === 'string') {
    if (
      /\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{10,}\b/i.test(value) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
      /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(value)
    ) {
      throw new Error('Do not persist credential-like values in a recipe');
    }
    try {
      const url = new URL(value);
      if (url.username || url.password) throw new Error('Recipe URLs must not contain userinfo');
      for (const keyName of url.searchParams.keys()) {
        if (/token|key|secret|password|auth|cookie/i.test(keyName)) {
          throw new Error(`Do not persist credential query parameter: ${keyName}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && /Recipe URLs|credential/.test(error.message)) throw error;
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoStoredCredentials);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(authorization|auth|api.?key|access.?token|cookie|password|secret|token|session.?id|tab.?id|document.?id|file.?path)$/i.test(
        key,
      )
    ) {
      throw new Error(`Do not persist credentials or ephemeral identity: ${key}`);
    }
    assertNoStoredCredentials(item);
  }
}

export function isVerifiedSkillPayload(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.startUrl === 'string' &&
    typeof candidate.inputSchema === 'object' &&
    typeof candidate.outputSchema === 'object' &&
    Array.isArray(candidate.tests)
  );
}

function extractPlaceholders(steps: string[][]): string[] {
  const keys = new Set<string>();
  for (const step of steps) {
    for (const part of step) {
      for (const match of part.matchAll(PLACEHOLDER_PATTERN)) {
        keys.add(match[1]);
      }
    }
  }
  return [...keys];
}

function inferDomainsFromSteps(steps: string[][]): string[] {
  const domains = new Set<string>();
  for (const step of steps) {
    for (const part of step) {
      if (!/^https?:\/\//i.test(part)) continue;
      try {
        const sanitized = part.replace(PLACEHOLDER_PATTERN, 'placeholder');
        const host = new URL(sanitized).hostname.toLowerCase();
        if (host && host !== 'localhost' && host !== '127.0.0.1' && DOMAIN_PATTERN.test(host)) {
          domains.add(host);
        }
      } catch {
        continue;
      }
    }
  }
  return [...domains];
}

export function validateSavedRecipe(input: unknown): SavedRecipe {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected a recipe object with id and steps.');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !RECIPE_ID_PATTERN.test(raw.id)) {
    throw new Error(
      'Recipe ID must begin with a lowercase letter and contain only letters, digits, or hyphens.',
    );
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 100) {
    throw new Error('Expected an array of 1–100 command argument arrays.');
  }
  const steps = raw.steps.map((args) => {
    if (
      !Array.isArray(args) ||
      args.length === 0 ||
      args.some((part) => typeof part !== 'string')
    ) {
      throw new Error('Each batch step must be an array of arguments.');
    }
    const separator = args.indexOf('--');
    for (const token of args.slice(0, separator < 0 ? args.length : separator)) {
      const volatile = /^--(tab|task|session|recipe)(?:=|$)/.exec(token);
      if (volatile)
        throw new Error(
          `Recipe steps cannot persist volatile targeting option --${volatile[1]}. Choose that context when running the recipe.`,
        );
    }
    const parsed = parseCommand(args);
    assertBatchStep(parsed);
    for (const index of TARGET_ARGUMENTS.get(parsed.name) ?? []) {
      const target = parsed.operands[index] ?? '';
      if (/^\d+$/.test(target))
        throw new Error(
          `Recipe step ${parsed.name} ${target} uses a volatile observed ref. Use a durable css:, text:, role:, or label: selector.`,
        );
    }
    return args as string[];
  });

  assertNoStoredCredentials(raw);

  const recipe: SavedRecipe = { id: raw.id, steps };
  if (raw.status !== undefined) {
    if (raw.status !== 'active' && raw.status !== 'candidate') {
      throw new Error('Recipe status must be active or candidate.');
    }
    recipe.status = raw.status;
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120) {
      throw new Error('Recipe name must be a non-empty string up to 120 characters.');
    }
    recipe.name = raw.name.trim();
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 500) {
      throw new Error('Recipe description must be a string up to 500 characters.');
    }
    recipe.description = raw.description.trim();
  }
  if (raw.notes !== undefined) {
    if (typeof raw.notes !== 'string' || raw.notes.length > 2000) {
      throw new Error('Recipe notes must be a string up to 2000 characters.');
    }
    recipe.notes = raw.notes.trim();
  }
  if (raw.domains !== undefined) {
    if (!Array.isArray(raw.domains) || raw.domains.length > 20) {
      throw new Error('Recipe domains must be an array of up to 20 hostnames.');
    }
    recipe.domains = raw.domains.map((entry) => {
      if (typeof entry !== 'string') throw new Error('Each recipe domain must be a hostname.');
      const normalized = entry
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
      if (!DOMAIN_PATTERN.test(normalized)) throw new Error(`Invalid recipe domain: ${entry}`);
      return normalized;
    });
  }
  if (raw.keywords !== undefined) {
    if (
      !Array.isArray(raw.keywords) ||
      raw.keywords.length > 40 ||
      raw.keywords.some((item) => typeof item !== 'string' || !item.trim())
    ) {
      throw new Error('Recipe keywords must be an array of up to 40 non-empty strings.');
    }
    recipe.keywords = raw.keywords.map((item) => item.trim());
  }
  if (raw.sourceUrls !== undefined) {
    if (
      !Array.isArray(raw.sourceUrls) ||
      raw.sourceUrls.length > 10 ||
      raw.sourceUrls.some((item) => typeof item !== 'string' || !/^https?:\/\//.test(item))
    ) {
      throw new Error('Recipe sourceUrls must be HTTP(S) URLs.');
    }
    recipe.sourceUrls = raw.sourceUrls;
  }
  if (raw.inputs !== undefined) {
    if (!raw.inputs || typeof raw.inputs !== 'object' || Array.isArray(raw.inputs)) {
      throw new Error('Recipe inputs must be an object mapping input names to specs.');
    }
    const validatedInputs: Record<string, RecipeInputSpec> = {};
    for (const [key, specRaw] of Object.entries(raw.inputs)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) throw new Error(`Invalid recipe input name: ${key}`);
      if (!specRaw || typeof specRaw !== 'object' || Array.isArray(specRaw)) {
        throw new Error(`Invalid recipe input spec for ${key}.`);
      }
      const spec = specRaw as Record<string, unknown>;
      const out: RecipeInputSpec = {};
      if (spec.type !== undefined) {
        if (typeof spec.type !== 'string' || !INPUT_TYPES.has(spec.type as RecipeInputType)) {
          throw new Error(`Unsupported input type for ${key}: ${String(spec.type)}`);
        }
        out.type = spec.type as RecipeInputType;
      }
      if (spec.required !== undefined) out.required = Boolean(spec.required);
      if (spec.default !== undefined) out.default = spec.default;
      if (typeof spec.description === 'string') out.description = spec.description.trim();
      validatedInputs[key] = out;
    }
    recipe.inputs = validatedInputs;
  }
  recipe.updatedAt = new Date().toISOString();
  return recipe;
}

export function schemaToInputSpecs(schema: unknown): Record<string, RecipeInputSpec> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const record = schema as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((item): item is string => typeof item === 'string')
      : [],
  );
  const specs: Record<string, RecipeInputSpec> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') continue;
    specs[key] = {
      ...(typeof prop.type === 'string' && INPUT_TYPES.has(prop.type as RecipeInputType)
        ? { type: prop.type as RecipeInputType }
        : {}),
      required: required.has(key),
      ...(prop.default !== undefined ? { default: prop.default } : {}),
      ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
    };
  }
  return specs;
}

export function savedRecipeInputs(recipe: SavedRecipe): Record<string, RecipeInputSpec> {
  const merged: Record<string, RecipeInputSpec> = { ...(recipe.inputs ?? {}) };
  for (const key of extractPlaceholders(recipe.steps)) {
    if (!merged[key]) {
      merged[key] = { type: 'string', required: true };
    }
  }
  return merged;
}

export function formatRunCommand(id: string, inputs: Record<string, RecipeInputSpec>): string {
  const args = Object.entries(inputs)
    .filter(([, spec]) => spec.required !== false && spec.default === undefined)
    .map(([key]) => `${key}=<${key}>`);
  return ['browserpaw recipe run', id, ...args].join(' ');
}

export function resolveBundledRecipesDirectory(homeDir = browserPawHome()): string | undefined {
  const candidates = [
    path.join(__dirname, 'recipes'),
    path.join(homeDir, 'host', 'recipes'),
    path.resolve(__dirname, '..', '..', '..', 'skills', 'browserpaw', 'assets', 'recipes'),
    path.join(__dirname, '..', 'dist', 'v5', 'recipes'),
    path.join(__dirname, '..', 'dist', 'recipes'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function readJsonSafe(filePath: string, maxBytes = 4 * 1024 * 1024): unknown | undefined {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export function loadLearnedWorkflows(
  homeDir = browserPawHome(),
  options: { includeCandidates?: boolean; includeBundled?: boolean; bundledDir?: string } = {},
): LearnedWorkflowSummary[] {
  const includeBundled = options.includeBundled ?? true;
  const byId = new Map<string, LearnedWorkflowSummary>();
  const suppressedBundledIds = new Set<string>();
  const recipesDir = recipesDirectory(homeDir);
  if (fs.existsSync(recipesDir) && !fs.lstatSync(recipesDir).isSymbolicLink()) {
    for (const file of fs
      .readdirSync(recipesDir)
      .filter((name) => /^[a-z][a-z0-9-]{0,63}(?:\.candidate)?\.json$/.test(name))
      .sort()) {
      const fullPath = path.join(recipesDir, file);
      const parsed = readJsonSafe(fullPath, 256 * 1024);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const rec = parsed as SavedRecipe;
      if (typeof rec.id !== 'string' || !Array.isArray(rec.steps)) continue;
      const candidateFile = file.endsWith('.candidate.json');
      const status = candidateFile || rec.status === 'candidate' ? 'candidate' : 'active';
      if (status === 'candidate' && !options.includeCandidates) continue;
      if (byId.has(rec.id)) continue;
      const inputs = savedRecipeInputs(rec);
      const domains = rec.domains?.length ? rec.domains : inferDomainsFromSteps(rec.steps);
      byId.set(rec.id, {
        id: rec.id,
        kind: 'recipe',
        status,
        name: rec.name || rec.id,
        description:
          rec.description || `Saved BrowserPaw CLI workflow (${rec.steps.length} steps).`,
        domains,
        keywords: rec.keywords ?? [],
        inputs,
        ...(rec.notes ? { notes: rec.notes } : {}),
        command: formatRunCommand(rec.id, inputs),
        sourcePath: fullPath,
      });
    }
  }

  const skillsDir = skillsDirectory(homeDir);
  if (fs.existsSync(skillsDir) && !fs.lstatSync(skillsDir).isSymbolicLink()) {
    for (const file of fs
      .readdirSync(skillsDir)
      .filter((name) => /^[a-z][a-z0-9-]{0,63}\.json$/.test(name))
      .sort()) {
      const fullPath = path.join(skillsDir, file);
      const parsed = readJsonSafe(fullPath);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as {
        id?: string;
        activeVersion?: number;
        autoUpdatePolicy?: string;
        versions?: Array<{
          version: number;
          status: string;
          definition?: {
            id: string;
            name?: string;
            description?: string;
            domains?: string[];
            keywords?: string[];
            inputSchema?: unknown;
            source?: { type?: string };
            steps?: unknown;
          };
        }>;
      };
      if (typeof record.id !== 'string' || !Array.isArray(record.versions)) continue;
      const active = record.versions.find(
        (item) => item.version === record.activeVersion && item.status === 'active',
      );
      const hasUserOwnedVersion = record.versions.some(
        (item) => item.definition?.source?.type && item.definition.source.type !== 'builtin',
      );
      const isDisabledByUser =
        record.autoUpdatePolicy === 'disabled' ||
        (!active && record.versions.some((item) => item.status === 'disabled'));
      if (hasUserOwnedVersion || isDisabledByUser) {
        suppressedBundledIds.add(record.id);
      }
      const latestCandidate = [...record.versions]
        .reverse()
        .find((item) => item.status === 'candidate');
      const autoDiscoverableBundled =
        !active &&
        includeBundled &&
        !suppressedBundledIds.has(record.id) &&
        latestCandidate?.definition &&
        isTrustedBundledReadOnlySkill(latestCandidate.definition)
          ? latestCandidate
          : undefined;
      const chosen =
        active ??
        autoDiscoverableBundled ??
        (options.includeCandidates ? latestCandidate : undefined);
      if (!chosen?.definition) continue;
      if (byId.has(record.id) && chosen.status !== 'active') continue;
      const def = chosen.definition;
      const inputs = schemaToInputSpecs(def.inputSchema);
      byId.set(record.id, {
        id: record.id,
        kind: 'skill',
        status:
          chosen.status === 'active' ? 'active' : autoDiscoverableBundled ? 'bundled' : 'candidate',
        name: def.name || record.id,
        description: def.description || '',
        domains: Array.isArray(def.domains) ? def.domains : [],
        keywords: Array.isArray(def.keywords) ? def.keywords : [],
        inputs,
        command: formatRunCommand(record.id, inputs),
        sourcePath: fullPath,
      });
    }
  }

  if (includeBundled || options.includeCandidates) {
    const bundledDir = options.bundledDir ?? resolveBundledRecipesDirectory(homeDir);
    if (bundledDir && fs.existsSync(bundledDir) && !fs.lstatSync(bundledDir).isSymbolicLink()) {
      for (const file of fs
        .readdirSync(bundledDir)
        .filter((name) => /^[a-z][a-z0-9-]{0,63}\.json$/.test(name))
        .sort()) {
        const fullPath = path.join(bundledDir, file);
        const parsed = readJsonSafe(fullPath, 256 * 1024);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const def = parsed as {
          id?: string;
          name?: string;
          description?: string;
          domains?: string[];
          keywords?: string[];
          inputSchema?: unknown;
        };
        if (typeof def.id !== 'string' || byId.has(def.id)) continue;
        if (suppressedBundledIds.has(def.id)) continue;
        const trustedBundled = isTrustedBundledReadOnlySkill(parsed);
        if (!trustedBundled && !options.includeCandidates) continue;
        if (trustedBundled && !includeBundled && !options.includeCandidates) continue;
        const inputs = schemaToInputSpecs(def.inputSchema);
        byId.set(def.id, {
          id: def.id,
          kind: 'skill',
          status: trustedBundled ? 'bundled' : 'candidate',
          name: def.name || def.id,
          description: def.description || '',
          domains: Array.isArray(def.domains) ? def.domains : [],
          keywords: Array.isArray(def.keywords) ? def.keywords : [],
          inputs,
          command: formatRunCommand(def.id, inputs),
          sourcePath: fullPath,
        });
      }
    }
  }

  const statusRank = (status: LearnedWorkflowSummary['status']) =>
    status === 'active' ? 0 : status === 'bundled' ? 1 : 2;
  return [...byId.values()].sort((left, right) => {
    if (left.status !== right.status) return statusRank(left.status) - statusRank(right.status);
    return left.id.localeCompare(right.id);
  });
}

function extractQuerySignals(query: string): { tokens: string[]; domains: string[]; raw: string } {
  const raw = query.trim().toLowerCase();
  const tokens = new Set<string>();
  const domains = new Set<string>();

  for (const match of raw.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    domains.add(match[1].toLowerCase());
  }
  for (const match of raw.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    domains.add(match[1].toLowerCase());
  }
  for (const part of raw.split(/[\s,，。、/|;:()（）【】[\]]+/).filter(Boolean)) {
    tokens.add(part);
  }
  for (const [pattern, expansions] of QUERY_ALIASES) {
    if (pattern.test(raw)) {
      for (const word of expansions) {
        tokens.add(word);
        if (word.includes('.')) domains.add(word);
      }
    }
  }
  return { tokens: [...tokens], domains: [...domains], raw };
}

export function matchLearnedWorkflows(
  entries: readonly LearnedWorkflowSummary[],
  filter: { url?: string; query?: string } = {},
): MatchedWorkflow[] {
  let pool = entries.slice();
  if (filter.url) {
    const hostname = new URL(filter.url).hostname.toLowerCase();
    pool = pool.filter((entry) =>
      entry.domains.some((domain) => domainMatchesHost(hostname, domain)),
    );
  }

  const query = filter.query?.trim() ?? '';
  if (!query) {
    return pool.map((entry) => ({ ...entry, score: filter.url ? 10 : 1 }));
  }

  const signals = extractQuerySignals(query);
  const scored: MatchedWorkflow[] = [];
  for (const entry of pool) {
    let score = 0;
    const idLower = entry.id.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    const descLower = `${entry.description} ${entry.notes ?? ''}`.toLowerCase();
    const keywordsLower = entry.keywords.map((item) => item.toLowerCase());
    const domainsLower = entry.domains.map((item) => item.toLowerCase());

    if (idLower === signals.raw) score += 100;
    else if (nameLower === signals.raw || keywordsLower.includes(signals.raw)) score += 60;
    else if (
      signals.raw.length >= 2 &&
      (idLower.includes(signals.raw) ||
        nameLower.includes(signals.raw) ||
        keywordsLower.some((kw) => kw.includes(signals.raw) || signals.raw.includes(kw)) ||
        descLower.includes(signals.raw))
    ) {
      score += 24;
    }

    for (const domain of signals.domains) {
      if (domainsLower.some((candidate) => domainMatchesHost(domain, candidate))) {
        score += 30;
      }
    }

    for (const token of signals.tokens) {
      if (idLower === token || keywordsLower.includes(token)) score += 16;
      else if (domainsLower.some((candidate) => domainMatchesHost(token, candidate))) score += 20;
      else if (
        token.length >= 2 &&
        (idLower.includes(token) ||
          nameLower.includes(token) ||
          keywordsLower.some((kw) => kw.includes(token)))
      ) {
        score += 10;
      } else if (token.length >= 2 && descLower.includes(token)) {
        score += 5;
      }
    }

    if (score > 0) scored.push({ ...entry, score });
  }

  return scored.sort((left, right) => {
    if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
    if (right.score !== left.score) return right.score - left.score;
    return left.id.localeCompare(right.id);
  });
}

export function listLearnedWorkflows(
  homeDir = browserPawHome(),
  options: { includeCandidates?: boolean; url?: string; query?: string } = {},
) {
  const all = loadLearnedWorkflows(homeDir, { includeCandidates: options.includeCandidates });
  const workflows =
    options.url || options.query
      ? matchLearnedWorkflows(all, { url: options.url, query: options.query })
      : all;
  return {
    homeDir,
    count: workflows.length,
    workflows: workflows.map(({ sourcePath: _ignored, ...item }) => item),
    saved: workflows.filter((item) => item.kind === 'recipe').map((item) => item.id),
  };
}

export function findLearnedWorkflows(
  homeDir = browserPawHome(),
  options: { includeCandidates?: boolean; url?: string; query?: string } = {},
) {
  const all = loadLearnedWorkflows(homeDir, { includeCandidates: options.includeCandidates });
  const matches = matchLearnedWorkflows(all, { url: options.url, query: options.query });
  return {
    homeDir,
    ...(options.query ? { query: options.query } : {}),
    ...(options.url ? { url: options.url } : {}),
    count: matches.length,
    matches: matches.map(({ sourcePath: _ignored, ...item }) => item),
  };
}

export function parseRecipeKeyValues(operands: readonly string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const part of operands) {
    const index = part.indexOf('=');
    if (index < 1) throw new Error('Recipe inputs use KEY=VALUE.');
    inputs[part.slice(0, index)] = part.slice(index + 1);
  }
  return inputs;
}

export function coerceWorkflowInputs(
  raw: Record<string, string>,
  specs: Record<string, RecipeInputSpec> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) && spec.default !== undefined) {
      result[key] = spec.default;
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    const type = specs[key]?.type;
    if (type === 'integer') {
      if (!/^-?\d+$/.test(value)) throw new Error(`Recipe input ${key} must be an integer.`);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error(`Recipe input ${key} must be an integer.`);
      result[key] = parsed;
    } else if (type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`Recipe input ${key} must be a number.`);
      result[key] = parsed;
    } else if (type === 'boolean') {
      if (value === 'true') result[key] = true;
      else if (value === 'false') result[key] = false;
      else throw new Error(`Recipe input ${key} must be true or false.`);
    } else if (type === 'object' || type === 'array') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`Recipe input ${key} must be valid JSON.`);
      }
      if (
        type === 'array'
          ? !Array.isArray(parsed)
          : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      ) {
        throw new Error(`Recipe input ${key} must be a JSON ${type}.`);
      }
      result[key] = parsed;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function expandRecipeSteps(steps: string[][], inputs: Record<string, unknown>): string[][] {
  return steps.map((step) =>
    step.map((part) => {
      const embeddedInUrl =
        /^https?:\/\//i.test(part) && !/^\{\{[a-zA-Z0-9_-]+\}\}$/.test(part.trim());
      return part.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(inputs, key) || inputs[key] === undefined) {
          throw new Error(`Missing recipe input ${key}.`);
        }
        const text =
          typeof inputs[key] === 'string' ? (inputs[key] as string) : JSON.stringify(inputs[key]);
        return embeddedInUrl ? encodeURIComponent(text) : text;
      });
    }),
  );
}

export function inspectLearnedWorkflow(
  id: string,
  homeDir = browserPawHome(),
  bundledDir?: string,
  preferActive = false,
): { summary: LearnedWorkflowSummary; definition: unknown } | undefined {
  if (!RECIPE_ID_PATTERN.test(id)) {
    throw new Error(
      'Recipe ID must begin with a lowercase letter and contain only letters, digits, or hyphens.',
    );
  }
  const active = preferActive
    ? loadLearnedWorkflows(homeDir, {
        includeCandidates: false,
        includeBundled: false,
        bundledDir,
      }).find((item) => item.id === id)
    : undefined;
  const candidatePath = candidateRecipeFilePath(id, homeDir);
  const candidate = active ? undefined : readJsonSafe(candidatePath, 256 * 1024);
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const recipe = validateSavedRecipe(candidate);
    const inputs = savedRecipeInputs(recipe);
    return {
      summary: {
        id: recipe.id,
        kind: 'recipe',
        status: 'candidate',
        name: recipe.name || recipe.id,
        description:
          recipe.description || `Saved BrowserPaw CLI workflow (${recipe.steps.length} steps).`,
        domains: recipe.domains?.length ? recipe.domains : inferDomainsFromSteps(recipe.steps),
        keywords: recipe.keywords ?? [],
        inputs,
        ...(recipe.notes ? { notes: recipe.notes } : {}),
        command: formatRunCommand(recipe.id, inputs),
        sourcePath: candidatePath,
      },
      definition: recipe,
    };
  }
  const summary =
    active ??
    loadLearnedWorkflows(homeDir, { includeCandidates: true, bundledDir }).find(
      (item) => item.id === id,
    );
  if (!summary) return undefined;
  const raw = readJsonSafe(summary.sourcePath);
  if (
    summary.kind === 'skill' &&
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { versions?: unknown[] }).versions)
  ) {
    const record = raw as {
      activeVersion?: number;
      versions: Array<{ version: number; status: string; definition: unknown; evidence?: unknown }>;
    };
    const selected =
      record.versions.find((item) => item.version === record.activeVersion) ??
      record.versions[record.versions.length - 1];
    return { summary, definition: selected?.definition ?? raw };
  }
  return { summary, definition: raw };
}

export function patchSavedRecipe(
  id: string,
  stepIndex: unknown,
  args: unknown,
  homeDir = browserPawHome(),
): SavedRecipe {
  const index =
    typeof stepIndex === 'number'
      ? stepIndex
      : typeof stepIndex === 'string' && /^\d+$/.test(stepIndex)
        ? Number(stepIndex)
        : NaN;
  const activePath = savedRecipeFilePath(id, homeDir);
  const active = readJsonSafe(activePath, 256 * 1024);
  const candidatePath = candidateRecipeFilePath(id, homeDir);
  const candidate = readJsonSafe(candidatePath, 256 * 1024);
  const source = candidate ?? active;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Unknown saved recipe: ${id}.`);
  }
  const recipe = validateSavedRecipe(source);
  if (!Number.isSafeInteger(index) || index < 0 || index >= recipe.steps.length) {
    throw new Error(`Recipe step index must be from 0 to ${recipe.steps.length - 1}.`);
  }
  if (!Array.isArray(args) || !args.length || args.some((part) => typeof part !== 'string')) {
    throw new Error('Replacement step must be a command argument array.');
  }
  const steps = recipe.steps.map((step, current) =>
    current === index ? [...(args as string[])] : step,
  );
  const patched = validateSavedRecipe({ ...recipe, status: 'candidate', steps });
  const { ensureDirectory, atomicWrite } = require('./cli-files.cjs');
  ensureDirectory(recipesDirectory(homeDir));
  atomicWrite(candidatePath, JSON.stringify(patched, null, 2) + '\n');
  return patched;
}

export function showLearnedWorkflow(
  id: string,
  homeDir = browserPawHome(),
  bundledDir?: string,
): { summary: Omit<LearnedWorkflowSummary, 'sourcePath'>; definition: unknown } | undefined {
  const inspected = inspectLearnedWorkflow(id, homeDir, bundledDir);
  if (!inspected) return undefined;
  const { sourcePath: _ignored, ...summary } = inspected.summary;
  return { summary, definition: inspected.definition };
}

export function syncLearnedRouting(
  homeDir = browserPawHome(),
  extraSkillPaths: readonly string[] = [],
): RoutingSyncResult {
  const { ensureDirectory, atomicWrite, readJson } = require('./cli-files.cjs');
  const activeWorkflows = loadLearnedWorkflows(homeDir, { includeCandidates: false });
  const indexPath = path.join(homeDir, 'learned-index.json');
  ensureDirectory(homeDir);
  atomicWrite(
    indexPath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        homeDir,
        workflows: activeWorkflows.map(({ sourcePath: _ignored, ...item }) => item),
      },
      null,
      2,
    )}\n`,
  );

  const installation = readJson(path.join(homeDir, 'installation.json')) as
    { skillPath?: string; skillPaths?: string[] } | undefined;
  const candidates = new Set<string>();
  for (const candidate of [
    ...(Array.isArray(installation?.skillPaths) ? installation.skillPaths : []),
    ...(typeof installation?.skillPath === 'string' ? [installation.skillPath] : []),
    ...extraSkillPaths,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      candidates.add(path.resolve(candidate));
    }
  }

  const routingEntries: LearnedRoutingEntry[] = activeWorkflows.map((item) => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    description: item.description,
    domains: item.domains,
    command: item.command,
  }));

  const syncedSkillPaths: string[] = [];
  for (const skillDir of candidates) {
    try {
      if (syncInstalledSkillRouting(skillDir, routingEntries)) {
        syncedSkillPaths.push(skillDir);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === 'ERR_BROWSERPAW_SKILL_MARKERS'
      )
        throw error;
      // Skip deleted, symlinked, or non-BrowserPaw directories without interrupting learning writes.
    }
  }
  return { indexPath, workflowCount: activeWorkflows.length, syncedSkillPaths };
}
