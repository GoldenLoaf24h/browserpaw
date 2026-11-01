import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { matchSemanticTarget } from './jev/semantic-match';
import { jevModelManager } from './server/jev-model-manager';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';
import {
  DOM_EXTRACTION_PROGRAM,
  DOM_EXTRACTION_PROGRAM_ALIAS,
  DOM_EXTRACTION_PROGRAM_HASH,
  PUBLISHED_READ_ONLY_PROGRAMS,
  UnsupportedReadOnlyProgramError,
  assertReadOnlyDomConfig,
  programHash,
} from './skill-read-program';

type JsonObject = Record<string, unknown>;
interface SkillVerification {
  tool: 'chrome_read_dom' | 'chrome_network_request';
  args: JsonObject;
  resultPath?: string;
}
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: { type: 'agent' | 'builtin'; urls: string[] };
  domains: string[];
  keywords: string[];
  startUrl: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  steps: Array<{ tool: string; args: JsonObject; resultPath?: string }>;
  verification: SkillVerification | SkillVerification[];
  tests: Array<{ inputs: JsonObject; expect: JsonObject; observe: JsonObject | JsonObject[] }>;
}

export interface SkillBrowser {
  start(name: string, sessionId?: string, signal?: AbortSignal): Promise<{ taskId: string }>;
  open(
    taskId: string,
    url: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<{ tabId: number }>;
  call(
    taskId: string,
    tool: string,
    args: JsonObject,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
  finish(taskId: string, sessionId?: string): Promise<void>;
}

interface SkillVersion {
  version: number;
  definition: SkillDefinition;
  hash: string;
  status: 'candidate' | 'active' | 'disabled' | 'verified';
  verifiedAt?: string;
  evidence: Array<{ taskId: string; inputHash: string; outputHash: string; at: string }>;
}
interface SkillRecord {
  id: string;
  activeVersion?: number;
  versions: SkillVersion[];
}

const validator = new AjvJsonSchemaValidator();
const allowedTools = new Set([
  'chrome_javascript',
  'chrome_read_dom',
  'chrome_get_markdown',
  'chrome_grep',
  'chrome_network_request',
  'chrome_screenshot',
]);
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

export interface SkillFindDiagnostic {
  strategy: 'exact' | 'semantic' | 'keyword' | 'none';
  status?: 'matched' | 'none' | 'ambiguous' | 'unavailable' | 'cancelled' | 'exact';
  matchedId?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  model?: string;
  reason?: string;
}

export type SkillSummaryWithDiagnostics = ReturnType<BrowserSkillStore['summary']> & {
  score?: number;
  diagnostics?: SkillFindDiagnostic;
};
export type SkillFindResult = SkillSummaryWithDiagnostics[];

class SkillContractError extends Error {}

function check(schema: JsonObject, value: unknown, label: string): void {
  const result = validator.getValidator(schema)(value);
  if (!result.valid) throw new SkillContractError(`${label}: ${result.errorMessage}`);
}

function assertNoCredentials(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(authorization|auth|api.?key|access.?token|cookie|password|secret|token|session.?id|tab.?id|document.?id|file.?path)$/i.test(
        key,
      )
    ) {
      throw new Error(`Do not persist credentials or ephemeral identity: ${key}`);
    }
    if (typeof item === 'string') {
      if (
        /\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{10,}\b/i.test(item) ||
        /\bAKIA[0-9A-Z]{16}\b/.test(item) ||
        /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(item) ||
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(item)
      ) {
        throw new Error('Do not persist credential-like values in a skill');
      }
      try {
        const url = new URL(item);
        if (url.username || url.password) throw new Error('Skill URLs must not contain userinfo');
        for (const keyName of url.searchParams.keys()) {
          if (/token|key|secret|password|auth|cookie/i.test(keyName)) {
            throw new Error('Skill URLs must not contain credential query parameters');
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Skill URLs')) throw error;
      }
    }
    assertNoCredentials(item);
  }
}

function unsupported(message: string): never {
  throw new UnsupportedReadOnlyProgramError(message);
}

function assertReadOnlyToolArgs(tool: string, args: JsonObject): void {
  if (tool === 'chrome_read_dom') {
    if (args.dismissOverlays !== undefined && args.dismissOverlays !== false)
      unsupported('Unsupported automatic skill: read_dom dismissOverlays can mutate the page');
    if (args.highlight !== undefined && args.highlight !== false)
      unsupported('Unsupported automatic skill: read_dom highlight can mutate the page');
  }
  if (tool === 'chrome_grep' && args.autoScroll !== undefined && args.autoScroll !== false) {
    unsupported('Unsupported automatic skill: grep autoScroll changes page scroll state');
  }
  if (tool === 'chrome_network_request') {
    if (args.method !== undefined && String(args.method).toUpperCase() !== 'GET') {
      unsupported('Unsupported automatic skill: only GET network reads are allowed');
    }
    if (args.body !== undefined || args.formData !== undefined) {
      unsupported('Unsupported automatic skill: network request bodies are not read-only');
    }
  }
  if (tool === 'chrome_screenshot') {
    if (args.savePng !== undefined && args.savePng !== false)
      unsupported('Unsupported automatic skill: screenshot savePng can write to disk');
    if (args.saveToDisk !== undefined && args.saveToDisk !== false)
      unsupported('Unsupported automatic skill: screenshot saveToDisk can write to disk');
    for (const key of ['fullPage', 'som', 'highlight', 'enableGrid']) {
      if (args[key] !== undefined && args[key] !== false)
        unsupported(`Unsupported automatic skill: screenshot ${key} mutates page state`);
    }
    if (
      args.grid !== undefined &&
      args.grid !== false &&
      args.grid !== 'none' &&
      args.grid !== 'off'
    ) {
      unsupported('Unsupported automatic skill: screenshot grid mutates page state');
    }
  }
}

function hasSpecificConstraint(schema: JsonObject): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return true;
  if (typeof schema.pattern === 'string' && schema.pattern.length > 0) return true;
  if (typeof schema.minItems === 'number' && schema.minItems > 0) return true;
  if (
    Array.isArray(schema.required) &&
    schema.required.length > 0 &&
    schema.required.every((key) => typeof key === 'string' && key.length > 0)
  ) {
    return true;
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((branch) => hasSpecificConstraint(branch))) {
      return true;
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    return Object.values(schema.properties).some((property) =>
      hasSpecificConstraint(property as JsonObject),
    );
  }
  return false;
}

function outputContract(schema: JsonObject): { success?: unknown; sources?: unknown } | null {
  const properties = schema?.properties;
  if (properties && typeof properties === 'object') {
    const record = properties as JsonObject;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (
      record.success &&
      record.sources &&
      required.includes('success') &&
      required.includes('sources')
    ) {
      return { success: record.success, sources: record.sources };
    }
  }
  const alternatives = Array.isArray(schema?.oneOf) ? schema.oneOf : [];
  for (const alternative of alternatives) {
    if (!alternative || typeof alternative !== 'object') continue;
    const contract = outputContract(alternative as JsonObject);
    if (contract) return contract;
  }
  return null;
}

function decode(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readSkillResult(result: CallToolResult): unknown {
  const decoded = decode(result);
  const state = decoded && typeof decoded === 'object' ? (decoded as JsonObject) : {};
  const uncertain = state.status === 'unknown' || state.outcome === 'unknown';
  const cancelled = state.status === 'cancelled';
  if (result.isError || state.success === false || uncertain || cancelled) {
    const description = JSON.stringify(decoded).slice(0, 1000);
    const unknown = uncertain || /outcome unknown/i.test(description);
    if (
      !unknown &&
      !cancelled &&
      /ambiguous|stale|strict|not found|missing element/i.test(description)
    )
      throw new SkillContractError(description);
    throw Object.assign(new Error(`Skill stopped; do not replay: ${description}`), {
      status: unknown
        ? 'unknown'
        : cancelled
          ? 'cancelled'
          : state.status === 'blocked'
            ? 'blocked'
            : 'failed',
      retry: false,
      result,
    });
  }
  if (state.truncated === true) throw new SkillContractError('output was truncated');
  return decoded;
}

function pointer(value: unknown, jsonPointer?: string): unknown {
  if (!jsonPointer) return value;
  if (!jsonPointer.startsWith('/'))
    throw new SkillContractError('resultPath must be a JSON pointer');
  return jsonPointer
    .slice(1)
    .split('/')
    .reduce<unknown>((node, token) => {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) {
        throw new SkillContractError(`output missing ${jsonPointer}`);
      }
      return (node as JsonObject)[key];
    }, value);
}

function expandUrl(template: string, inputs: JsonObject): string {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, key) => {
    if (typeof inputs[key] !== 'string' && typeof inputs[key] !== 'number') {
      throw new SkillContractError(`URL input ${key} must be a string or number`);
    }
    return encodeURIComponent(String(inputs[key]));
  });
}

function assertDomain(url: string, definition: SkillDefinition): void {
  const parsed = new URL(url);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !definition.domains.includes(parsed.hostname)
  ) {
    throw new SkillContractError('Skill URL must match an explicitly declared HTTP(S) domain');
  }
}

/** Runs bounded, read-oriented recipes through the existing task executor, never Node eval. */

export class BrowserSkillStore {
  private readonly root: string;
  private readonly browser: SkillBrowser;
  private readonly running = new Set<string>();
  private readonly executions = new Map<string, number>();
  private readonly approvedPrograms = new Set<string>([DOM_EXTRACTION_PROGRAM_HASH]);

  constructor(options: { root?: string; browser: SkillBrowser }) {
    this.root = path.resolve(
      options.root ||
        path.join(process.env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw'), 'skills'),
    );
    this.browser = options.browser;
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink())
      throw new Error('Skill directory cannot be a symbolic link');
  }

  private resolveProgramStep(
    step: { tool: string; args: JsonObject },
    approvedPrograms: ReadonlySet<string> = this.approvedPrograms,
  ): { code: string; config?: unknown } {
    const hasCode = Object.prototype.hasOwnProperty.call(step.args, 'code');
    const hasProgram = Object.prototype.hasOwnProperty.call(step.args, 'program');
    if (hasCode === hasProgram) {
      unsupported(
        'Unsupported automatic skill: JavaScript steps require exactly one of code or program',
      );
    }

    let code: string;
    if (hasProgram) {
      if (step.args.program !== DOM_EXTRACTION_PROGRAM_ALIAS) {
        unsupported(`Unsupported automatic skill program alias: ${String(step.args.program)}`);
      }
      code = DOM_EXTRACTION_PROGRAM;
    } else {
      if (typeof step.args.code !== 'string' || step.args.code.length > 32768) {
        unsupported('Unsupported automatic skill: JavaScript program is not a bounded string');
      }
      code = step.args.code;
      if (!approvedPrograms.has(programHash(code))) {
        unsupported(
          'Unsupported automatic skill: JavaScript must exactly match a locally reviewed bundled read-only program',
        );
      }
    }

    if (hasProgram && step.args.config === undefined) {
      unsupported('Unsupported automatic skill: dom-extract requires a config object');
    }
    if (step.args.config !== undefined) {
      if (hasCode && programHash(code) !== DOM_EXTRACTION_PROGRAM_HASH) {
        unsupported(
          'Unsupported automatic skill: data config is only valid with the reviewed DOM extraction program',
        );
      }
      return { code, config: assertReadOnlyDomConfig(step.args.config) };
    }
    return { code };
  }

  private assertSupportedDefinition(
    definition: SkillDefinition,
    approvedPrograms: ReadonlySet<string> = this.approvedPrograms,
  ): void {
    if (!Array.isArray(definition.steps) || !definition.steps.length) {
      unsupported('Unsupported automatic skill: executable steps are required');
    }
    for (const step of definition.steps) {
      if (!step || !step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
        unsupported('Unsupported automatic skill: every step requires object arguments');
      }
      if (!allowedTools.has(step.tool)) {
        unsupported(`Unsupported automatic skill tool: ${step.tool}`);
      }
      if (step.tool === 'chrome_javascript') {
        this.resolveProgramStep(step, approvedPrograms);
      } else if (step.args.config !== undefined) {
        unsupported(`Unsupported automatic skill: ${step.tool} cannot use page-program config`);
      }
      assertReadOnlyToolArgs(step.tool, step.args);
    }

    const verifications = Array.isArray(definition.verification)
      ? definition.verification
      : [definition.verification];
    for (const verification of verifications) {
      if (
        !verification ||
        !verification.args ||
        typeof verification.args !== 'object' ||
        Array.isArray(verification.args) ||
        !['chrome_read_dom', 'chrome_network_request'].includes(verification.tool)
      ) {
        unsupported('Unsupported automatic skill: verification must be a DOM or GET read');
      }
      assertReadOnlyToolArgs(verification.tool, verification.args);
    }
  }

  private filename(id: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid skill id');
    const filename = path.join(this.root, `${id}.json`);
    if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) {
      throw new Error('Skill record cannot be a symbolic link');
    }
    return filename;
  }

  private read(id: string): SkillRecord {
    const filename = this.filename(id);
    if (fs.statSync(filename).size > 4 * 1024 * 1024) throw new Error('Skill record too large');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as SkillRecord;
    if (record.id !== id || !Array.isArray(record.versions))
      throw new Error('Invalid skill record');
    for (const version of record.versions) {
      if (version.hash !== hash(version.definition))
        throw new Error('Skill content changed; propose and verify a new version');
    }
    return record;
  }

  private write(record: SkillRecord): void {
    const destination = this.filename(record.id);
    const temporary = path.join(this.root, `.${record.id}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private summary(record: SkillRecord, version: SkillVersion) {
    const def = version.definition;
    return {
      id: record.id,
      version: version.version,
      status: version.status,
      name: def.name,
      description: def.description,
      domains: def.domains,
      keywords: def.keywords,
      verifiedAt: version.verifiedAt,
      hash: version.hash,
    };
  }

  list() {
    return fs
      .readdirSync(this.root)
      .filter((name) => /^[a-z][a-z0-9-]*\.json$/.test(name))
      .flatMap((name) => {
        const record = this.read(name.slice(0, -5));
        const version = record.versions.find(
          (item) => item.version === record.activeVersion && item.status === 'active',
        );
        if (!version) return [];
        try {
          this.assertSupportedDefinition(version.definition);
          return [this.summary(record, version)];
        } catch {
          return [];
        }
      });
  }
  async find(
    url: string,
    intent = '',
    options?: { signal?: AbortSignal },
  ): Promise<SkillFindResult> {
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('Skill find cancelled'), {
        status: 'cancelled',
        retry: false,
        requestDispatched: false,
      });
    }

    // Do not catch invalid URL: let new URL throw explicitly
    const hostname = new URL(url).hostname;

    const matching = this.list().filter((item) => item.domains.includes(hostname));
    if (matching.length === 0) {
      return [];
    }

    const trimmedIntent = intent.trim();
    const terms = trimmedIntent.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = matching.map((item) => ({
      ...item,
      score: terms.filter((term) =>
        `${item.name} ${item.description} ${item.keywords.join(' ')}`.toLowerCase().includes(term),
      ).length,
    }));

    // If no intent was provided, return keyword sorted slice directly without model
    if (!trimmedIntent) {
      const diag: SkillFindDiagnostic = { strategy: 'keyword', reason: 'no_intent' };
      return scored.slice(0, 3).map((item) => ({ ...item, diagnostics: diag }));
    }

    // Zero-model exact match check: requires explicit name, id, or keyword match
    const normalizedIntent = trimmedIntent.toLowerCase();
    const exactNameOrIdMatches = scored.filter(
      (item) =>
        item.id.toLowerCase() === normalizedIntent ||
        item.name.toLowerCase() === normalizedIntent ||
        item.keywords.some((k) => k.toLowerCase() === normalizedIntent),
    );

    const positiveScored = scored.filter((item) => item.score > 0);
    const hasUniqueExact =
      exactNameOrIdMatches.length === 1 ||
      (positiveScored.length === 1 && positiveScored[0].score >= terms.length);

    if (hasUniqueExact) {
      const top = exactNameOrIdMatches.length === 1 ? exactNameOrIdMatches[0] : positiveScored[0];
      const others = scored.filter((item) => item.id !== top.id).sort((a, b) => b.score - a.score);
      const diag: SkillFindDiagnostic = {
        strategy: 'exact',
        status: 'exact',
        matchedId: top.id,
        reason:
          exactNameOrIdMatches.length === 1
            ? 'exact_name_or_keyword_match'
            : 'unique_keyword_score_match',
      };
      return [top, ...others].slice(0, 3).map((item) => ({ ...item, diagnostics: diag }));
    }

    // Ambiguity exists.
    // Rule: >32 candidates -> do NOT slice and call model. Fallback to keyword and flag coverage_limited.
    if (matching.length > 32) {
      const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, 3);
      const diag: SkillFindDiagnostic = {
        strategy: 'keyword',
        status: 'unavailable',
        reason: 'coverage_limited',
      };
      return sorted.map((item) => ({ ...item, diagnostics: diag }));
    }

    // If model is explicitly off, fallback to keyword ranking without model
    if (jevModelManager.getActiveMode() === 'off') {
      const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, 3);
      const diag: SkillFindDiagnostic = {
        strategy: 'keyword',
        status: 'unavailable',
        reason: 'jev_disabled',
      };
      return sorted.map((item) => ({ ...item, diagnostics: diag }));
    }

    // Run semantic match target
    const targetResult = await matchSemanticTarget(
      {
        query: trimmedIntent || url,
        intent: trimmedIntent,
        candidates: matching.map((item) => ({
          id: item.id,
          text: `${item.name}: ${item.description}`,
        })),
        operation: 'skill',
      },
      options?.signal,
    );

    if (targetResult.status === 'cancelled' || options?.signal?.aborted) {
      throw Object.assign(new Error('Skill find cancelled'), {
        status: 'cancelled',
        retry: false,
        requestDispatched: false,
      });
    }

    if (targetResult.status === 'matched' && targetResult.matchedId) {
      const matchedItem = scored.find((item) => item.id === targetResult.matchedId);
      const others = scored
        .filter((item) => item.id !== targetResult.matchedId)
        .sort((a, b) => b.score - a.score);
      const diag: SkillFindDiagnostic = {
        strategy: 'semantic',
        status: 'matched',
        matchedId: targetResult.matchedId,
        confidence: targetResult.confidence,
        probabilities: targetResult.probabilities,
        model: targetResult.model,
      };
      const combined = matchedItem ? [matchedItem, ...others] : scored;
      return combined.slice(0, 3).map((item) => ({ ...item, diagnostics: diag }));
    }

    if (targetResult.status === 'none') {
      return [];
    }

    // Ambiguous or unavailable
    const diag: SkillFindDiagnostic = {
      strategy: 'keyword',
      status: targetResult.status,
      confidence: targetResult.confidence,
      probabilities: targetResult.probabilities,
      model: targetResult.model,
      reason:
        targetResult.reason ||
        (targetResult.status === 'ambiguous' ? 'semantic_ambiguous' : 'model_unavailable'),
    };
    return [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => ({ ...item, diagnostics: diag }));
  }
  get(id: string, requestedVersion?: number) {
    const record = this.read(id);
    const version = record.versions.find(
      (item) =>
        item.version ===
        (requestedVersion ??
          record.activeVersion ??
          record.versions[record.versions.length - 1]?.version),
    );
    if (!version) throw new Error('No matching verified skill version');
    let executionSupported = true;
    let unsupportedReason: string | undefined;
    try {
      this.assertSupportedDefinition(version.definition);
    } catch (error) {
      executionSupported = false;
      unsupportedReason = error instanceof Error ? error.message : String(error);
    }
    return {
      ...this.summary(record, version),
      executionSupported,
      ...(unsupportedReason ? { unsupportedReason } : {}),
      definition: version.definition,
      evidence: version.evidence,
    };
  }

  async loadBundledSkills(directory: string): Promise<void> {
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error('Bundled skill directory cannot be a symbolic link');
    const definitions: SkillDefinition[] = [];
    for (const name of fs
      .readdirSync(directory)
      .filter((item) => /^[a-z][a-z0-9-]*\.json$/.test(item))) {
      const filename = path.join(directory, name);
      if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > 128 * 1024) {
        throw new Error('Invalid bundled skill file');
      }
      definitions.push(JSON.parse(fs.readFileSync(filename, 'utf8')) as SkillDefinition);
    }

    const approved = new Set(this.approvedPrograms);
    for (const definition of definitions) {
      if (!Array.isArray(definition.steps) || !definition.steps.length) {
        unsupported(`Unsupported bundled skill ${definition.id}: executable steps are required`);
      }
      for (const step of definition.steps) {
        if (!step || !step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
          continue;
        }
        if (step.tool !== 'chrome_javascript') continue;
        const hasCode = Object.prototype.hasOwnProperty.call(step.args, 'code');
        const hasProgram = Object.prototype.hasOwnProperty.call(step.args, 'program');
        if (hasCode && hasProgram) continue;
        if (hasProgram) {
          if (step.args.program !== DOM_EXTRACTION_PROGRAM_ALIAS) {
            unsupported(
              `Unsupported bundled skill ${definition.id}: unknown program alias ${String(step.args.program)}`,
            );
          }
          continue;
        }
        if (typeof step.args.code !== 'string') continue;
        const digest = programHash(step.args.code);
        if (digest === DOM_EXTRACTION_PROGRAM_HASH) {
          approved.add(digest);
          continue;
        }
        const publishedHash = PUBLISHED_READ_ONLY_PROGRAMS[definition.id];
        if (publishedHash !== digest) {
          unsupported(
            `Unsupported bundled skill ${definition.id}: JavaScript is not a locally reviewed published program`,
          );
        }
        approved.add(digest);
      }
      this.assertSupportedDefinition(definition, approved);
    }
    for (const digest of approved) this.approvedPrograms.add(digest);

    for (const definition of definitions) {
      const target = this.filename(definition.id);
      if (
        !fs.existsSync(target) ||
        !this.read(definition.id).versions.some((item) => item.hash === hash(definition))
      ) {
        await this.propose(definition);
      }
    }
  }

  async propose(definition: SkillDefinition) {
    const filename = this.filename(definition.id);
    if (Buffer.byteLength(JSON.stringify(definition)) > 128 * 1024)
      throw new Error('Skill definition exceeds 128 KiB');
    this.assertSupportedDefinition(definition);
    assertNoCredentials(definition);
    if (
      !definition.source ||
      !['agent', 'builtin'].includes(definition.source.type) ||
      !Array.isArray(definition.source.urls) ||
      definition.source.urls.length === 0 ||
      definition.source.urls.some((url) => !/^https?:\/\//.test(url))
    ) {
      throw new Error('Skill requires source attribution with HTTP(S) evidence URLs');
    }
    if (
      !definition.name ||
      !definition.description ||
      !Array.isArray(definition.domains) ||
      !definition.domains.length ||
      !Array.isArray(definition.keywords) ||
      !Array.isArray(definition.steps) ||
      !definition.steps.length ||
      definition.steps.length > 20
    ) {
      throw new Error(
        'Skill requires name, description, domains, keywords and 1–20 executable steps',
      );
    }
    if (
      !Array.isArray(definition.tests) ||
      definition.tests.length < 2 ||
      new Set(definition.tests.map((test) => stable(test.inputs))).size < 2
    ) {
      throw new Error('Verification requires at least two different inputs');
    }
    const verifications = Array.isArray(definition.verification)
      ? definition.verification
      : [definition.verification];
    if (!verifications.length || verifications.length > 8)
      throw new Error('Independent verification requires 1–8 observations');
    for (const test of definition.tests) {
      if (
        !test.observe ||
        !Object.keys(test.observe).length ||
        !test.expect ||
        !Object.keys(test.expect).length
      ) {
        throw new Error(
          'Verification requires explicit output and independent observation assertions',
        );
      }
      check(definition.inputSchema, test.inputs, 'input');
      validator.getValidator(test.expect);
      const observations = Array.isArray(test.observe) ? test.observe : [test.observe];
      if (observations.length !== verifications.length)
        throw new Error('Each verification requires a corresponding observation assertion');
      for (const observation of observations) {
        if (!observation || typeof observation !== 'object' || Array.isArray(observation))
          throw new Error('Independent observation assertion must be an object schema');
        if (!hasSpecificConstraint(observation))
          throw new Error('Independent observation must contain a concrete assertion');
        validator.getValidator(observation);
      }
      assertDomain(expandUrl(definition.startUrl, test.inputs), definition);
    }
    for (const verification of verifications) {
      if (
        !verification ||
        !verification.args ||
        typeof verification.args !== 'object' ||
        Array.isArray(verification.args) ||
        !['chrome_read_dom', 'chrome_network_request'].includes(verification.tool)
      ) {
        throw new Error(
          'Independent verification requires a DOM observation or GET response, not candidate JavaScript',
        );
      }
      assertReadOnlyToolArgs(verification.tool, verification.args);
      const verificationSchema = TOOL_SCHEMAS.find(
        (tool) => tool.name === verification.tool,
      )?.inputSchema;
      if (!verificationSchema) throw new Error('Unknown verification tool');
      const verificationArgs = validator.getValidator(verificationSchema)(verification.args);
      if (!verificationArgs.valid) {
        throw new Error(`Invalid args for ${verification.tool}: ${verificationArgs.errorMessage}`);
      }
    }
    validator.getValidator(definition.outputSchema);
    const contract = outputContract(definition.outputSchema);
    if (!contract?.success || !contract.sources) {
      throw new Error('Skill outputSchema must declare success and source evidence');
    }
    if (JSON.stringify(contract.success) !== JSON.stringify({ const: true })) {
      throw new Error('Skill success must be a const true assertion');
    }
    for (const step of definition.steps) {
      if (!allowedTools.has(step.tool))
        throw new Error(`Unsupported read-oriented skill tool: ${step.tool}; do not persist refs`);
      const toolSchema = TOOL_SCHEMAS.find((tool) => tool.name === step.tool)?.inputSchema;
      if (!toolSchema) throw new Error(`Unknown tool schema: ${step.tool}`);
      const toolArgs = { ...step.args };
      delete toolArgs.config;
      delete toolArgs.program;
      if (step.tool === 'chrome_javascript') {
        toolArgs.code = this.resolveProgramStep(step).code;
      }
      const argsResult = validator.getValidator(toolSchema)(toolArgs);
      if (!argsResult.valid) {
        throw new Error(`Invalid args for ${step.tool}: ${argsResult.errorMessage}`);
      }
      if (step.resultPath && !step.resultPath.startsWith('/'))
        throw new Error('Invalid resultPath');
    }
    for (const test of definition.tests) {
      if (!hasSpecificConstraint(test.expect)) {
        throw new Error('Verification output must contain a concrete assertion');
      }
    }
    const record: SkillRecord = fs.existsSync(filename)
      ? this.read(definition.id)
      : { id: definition.id, versions: [] };
    if (this.running.has(definition.id)) throw new Error('Skill is being validated or executed');
    const version: SkillVersion = {
      version: Math.max(0, ...record.versions.map((item) => item.version)) + 1,
      definition: JSON.parse(JSON.stringify(definition)),
      hash: hash(definition),
      status: 'candidate',
      evidence: [],
    };
    record.versions.push(version);
    this.write(record);
    return this.summary(record, version);
  }

  private async executeVersion(
    version: SkillVersion,
    inputs: JsonObject,
    callerTaskId?: string,
    observationSchema?: JsonObject | JsonObject[],
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<{ output: unknown; taskId: string }> {
    const checkCancelled = () => {
      if (signal?.aborted)
        throw Object.assign(new Error('Skill cancelled; dispatched actions were not rolled back'), {
          status: 'cancelled',
          retry: false,
        });
    };
    checkCancelled();
    const def = version.definition;
    this.assertSupportedDefinition(def);
    check(def.inputSchema, inputs, 'input');
    if (!outputContract(def.outputSchema)) {
      throw new Error('Skill output contract is no longer valid');
    }
    const url = expandUrl(def.startUrl, inputs);
    assertDomain(url, def);
    const taskId =
      callerTaskId || (await this.browser.start(`Skill: ${def.name}`, sessionId, signal)).taskId;
    let output: unknown;
    let failure: unknown;
    let failed = false;
    try {
      checkCancelled();
      const { tabId } = await this.browser.open(taskId, url, sessionId, signal);
      for (const step of def.steps) {
        checkCancelled();
        const args: JsonObject = { ...step.args, tabId };
        delete args.config;
        delete args.program;
        if (step.tool === 'chrome_javascript') {
          const program = this.resolveProgramStep(step);
          const runtimeInputs =
            program.config === undefined ? inputs : { ...inputs, config: program.config };
          args.code = `const input = ${JSON.stringify(runtimeInputs)};\n${program.code}`;
        }
        if (step.tool === 'chrome_network_request') {
          args.url = expandUrl(String(args.url), inputs);
          assertDomain(String(args.url), def);
        }
        const result = await this.browser.call(taskId, step.tool, args, sessionId, signal);
        const decoded = readSkillResult(result);
        output = pointer(decoded, step.resultPath);
        if (step.tool === 'chrome_javascript' && typeof output === 'string') {
          try {
            output = JSON.parse(output);
          } catch {
            /* Plain string results stay strings. */
          }
        }
        if (output && typeof output === 'object' && (output as JsonObject).success === false) {
          throw Object.assign(new Error('Skill result is not successful'), {
            status: 'blocked',
            retry: false,
            output,
          });
        }
      }
      check(def.outputSchema, output, 'output');
      checkCancelled();
      if (observationSchema) {
        const verifications = Array.isArray(def.verification)
          ? def.verification
          : [def.verification];
        const schemas = Array.isArray(observationSchema) ? observationSchema : [observationSchema];
        if (schemas.length !== verifications.length)
          throw new SkillContractError('Independent observation count changed');
        for (let i = 0; i < verifications.length; i++) {
          checkCancelled();
          const verify = verifications[i];
          const args: JsonObject = { ...verify.args, tabId };
          if (verify.tool === 'chrome_network_request') {
            args.url = expandUrl(String(args.url), inputs);
            assertDomain(String(args.url), def);
          }
          const observed = await this.browser.call(taskId, verify.tool, args, sessionId, signal);
          const decoded = readSkillResult(observed);
          if (
            decoded &&
            typeof decoded === 'object' &&
            (decoded as JsonObject).coverage &&
            (((decoded as JsonObject).coverage as JsonObject).partial === true ||
              ((decoded as JsonObject).coverage as JsonObject).status === 'incomplete')
          ) {
            throw new SkillContractError('Independent observation has incomplete frame coverage');
          }
          check(schemas[i], pointer(decoded, verify.resultPath), 'independent observation');
        }
      }
      checkCancelled();
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (!callerTaskId) {
      try {
        await this.browser.finish(taskId, sessionId);
      } catch (cleanupError) {
        if (!failed) throw cleanupError;
        if (failure instanceof Error) Object.assign(failure, { cleanupError });
      }
    }
    if (failed) throw failure;
    return { output, taskId };
  }

  async validate(id: string, requestedVersion?: number, signal?: AbortSignal, sessionId?: string) {
    if (this.running.has(id) || this.executions.has(id))
      throw new Error('Skill is already running');
    const record = this.read(id);
    const version =
      record.versions.find((item) => item.version === requestedVersion) ||
      (requestedVersion === undefined ? record.versions[record.versions.length - 1] : undefined);
    if (!version || version.status !== 'candidate')
      throw new Error('Select a candidate skill version');
    this.assertSupportedDefinition(version.definition);
    this.running.add(id);
    try {
      version.evidence = [];
      for (const test of version.definition.tests) {
        const { output, taskId } = await this.executeVersion(
          version,
          test.inputs,
          undefined,
          test.observe,
          signal,
          sessionId,
        );
        check(test.expect, output, 'verification output');
        version.evidence.push({
          taskId,
          inputHash: hash(test.inputs),
          outputHash: hash(output),
          at: new Date().toISOString(),
        });
      }
      for (const old of record.versions) if (old.status === 'active') old.status = 'verified';
      version.status = 'active';
      version.verifiedAt = new Date().toISOString();
      record.activeVersion = version.version;
      this.write(record);
      return this.summary(record, version);
    } finally {
      this.running.delete(id);
    }
  }

  async run(
    id: string,
    inputs: JsonObject,
    taskId?: string,
    signal?: AbortSignal,
    sessionId?: string,
    options?: { version?: number; definitionHash?: string },
  ) {
    if (this.running.has(id)) throw new Error('Skill is already running');
    const record = this.read(id);
    const version = record.versions.find(
      (item) => item.version === record.activeVersion && item.status === 'active',
    );
    if (!version) throw new Error('No active verified skill');

    if (options?.version !== undefined && options.version !== version.version) {
      throw Object.assign(
        new Error(
          `Specified skill version ${options.version} does not match active version ${version.version}`,
        ),
        {
          status: 'blocked',
          retry: false,
          requestDispatched: false,
        },
      );
    }
    if (options?.definitionHash !== undefined && options.definitionHash !== version.hash) {
      throw Object.assign(
        new Error(
          `Specified definition hash ${options.definitionHash} does not match skill version hash ${version.hash}`,
        ),
        {
          status: 'blocked',
          retry: false,
          requestDispatched: false,
        },
      );
    }

    this.assertSupportedDefinition(version.definition);
    this.executions.set(id, (this.executions.get(id) || 0) + 1);
    try {
      return {
        id,
        version: version.version,
        hash: version.hash,
        ...(await this.executeVersion(version, inputs, taskId, undefined, signal, sessionId)),
      };
    } catch (error) {
      if (error instanceof SkillContractError && !error.message.startsWith('input:')) {
        const current = this.read(id);
        const failedVersion = current.versions.find((item) => item.version === version.version);
        if (failedVersion) failedVersion.status = 'disabled';
        if (current.activeVersion === version.version) current.activeVersion = undefined;
        this.write(current);
      }
      throw error;
    } finally {
      const remaining = (this.executions.get(id) || 1) - 1;
      if (remaining) this.executions.set(id, remaining);
      else this.executions.delete(id);
    }
  }

  async disable(id: string) {
    if (this.running.has(id) || this.executions.has(id)) throw new Error('Skill is running');
    const record = this.read(id);
    const version = record.versions.find((item) => item.version === record.activeVersion);
    if (version) version.status = 'disabled';
    record.activeVersion = undefined;
    this.write(record);
    return { id, status: 'disabled' };
  }

  async rollback(id: string, requestedVersion: number) {
    if (this.running.has(id) || this.executions.has(id)) throw new Error('Skill is running');
    const record = this.read(id);
    const target = record.versions.find(
      (item) => item.version === requestedVersion && item.verifiedAt && item.status !== 'disabled',
    );
    if (!target)
      throw new Error('Rollback requires an independently verified, non-disabled version');
    this.assertSupportedDefinition(target.definition);
    for (const old of record.versions) if (old.status === 'active') old.status = 'verified';
    target.status = 'active';
    record.activeVersion = target.version;
    this.write(record);
    return this.summary(record, target);
  }
}
