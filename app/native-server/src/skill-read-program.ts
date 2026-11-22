import { createHash } from 'node:crypto';

export class UnsupportedReadOnlyProgramError extends Error {
  readonly status = 'unsupported';
  readonly retry = false;

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedReadOnlyProgramError';
  }
}

export interface ReadOnlyDomField {
  name: string;
  selector: string;
  value: 'text' | 'attribute';
  attribute?: string;
  multiple?: boolean;
}

export interface ReadOnlyDomConfig {
  fields: ReadOnlyDomField[];
}

export interface ReadOnlyProgramStep {
  tool: 'chrome_javascript';
  args: {
    program: typeof DOM_EXTRACTION_PROGRAM_ALIAS;
    config: ReadOnlyDomConfig;
  };
  resultPath: '/result';
}

export const DOM_EXTRACTION_PROGRAM_ALIAS = 'dom-extract';
export const DOM_EXTRACTION_MAX_MATCHES = 250;
export const DOM_EXTRACTION_MAX_VALUE_CHARS = 10_000;

export const DOM_EXTRACTION_PROGRAM = `const config = input && input.config;
if (!config || !Array.isArray(config.fields) || config.fields.length < 1 || config.fields.length > 32) {
  return { success: false, status: 'invalid_config', message: 'DOM extraction requires 1-32 fields' };
}
if (!document || typeof document.querySelectorAll !== 'function') {
  return { success: false, status: 'invalid_page', message: 'document.querySelectorAll is unavailable' };
}
const fields = {};
for (let index = 0; index < config.fields.length; index += 1) {
  const field = config.fields[index];
  if (!field || typeof field.name !== 'string' || typeof field.selector !== 'string' || !('value' in field)) {
    return { success: false, status: 'invalid_config', message: 'DOM extraction field shape is invalid', field: String(field && field.name || index) };
  }
  if (field.value !== 'text' && field.value !== 'attribute') {
    return { success: false, status: 'invalid_config', message: 'DOM extraction value must be text or attribute', field: field.name };
  }
  if (Object.prototype.hasOwnProperty.call(fields, field.name)) {
    return { success: false, status: 'invalid_config', message: 'DOM extraction field names must be unique', field: field.name };
  }
  let matches;
  try {
    matches = document.querySelectorAll(field.selector);
  } catch (error) {
    return { success: false, status: 'invalid_selector', message: String(error && error.message || error), field: field.name };
  }
  const count = typeof matches.length === 'number' ? matches.length : Array.from(matches).length;
  if (count > ${DOM_EXTRACTION_MAX_MATCHES}) {
    return { success: false, status: 'limit_exceeded', field: field.name, count, limit: ${DOM_EXTRACTION_MAX_MATCHES} };
  }
  const nodes = Array.from(matches);
  const values = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    let value;
    if (field.value === 'text') value = String(node && (node.innerText ?? node.textContent) || '').trim();
    else if (field.value === 'attribute') {
      const attribute = typeof node.getAttribute === 'function' ? node.getAttribute(field.attribute) : null;
      value = attribute === null || attribute === undefined ? null : String(attribute);
    }
    if (typeof value === 'string' && value.length > ${DOM_EXTRACTION_MAX_VALUE_CHARS}) {
      return { success: false, status: 'value_limit_exceeded', field: field.name, index: nodeIndex, length: value.length, limit: ${DOM_EXTRACTION_MAX_VALUE_CHARS} };
    }
    values.push(value);
  }
  if (field.multiple === true) fields[field.name] = values;
  else fields[field.name] = values.length ? values[0] : null;
}
return { success: true, fields, sources: { page: location.href } };`;

export const DOM_EXTRACTION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    success: { const: true },
    fields: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          { type: 'string' },
          { type: 'null' },
          { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
        ],
      },
    },
    sources: {
      type: 'object',
      properties: { page: { type: 'string', minLength: 1 } },
      required: ['page'],
      additionalProperties: false,
    },
  },
  required: ['success', 'fields', 'sources'],
  additionalProperties: false,
};

const FIELD_KEYS = new Set(['name', 'selector', 'value', 'attribute', 'multiple']);
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9:_.-]{0,127}$/;

export function assertReadOnlyDomConfig(value: unknown): ReadOnlyDomConfig {
  const fail = (message: string): never => {
    throw new UnsupportedReadOnlyProgramError(
      `Unsupported read-only DOM extraction config: ${message}`,
    );
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('config must be an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'fields')) fail('unknown config key');
  const rawFields = record.fields;
  if (!Array.isArray(rawFields) || rawFields.length < 1 || rawFields.length > 32) {
    fail('fields must contain 1-32 entries');
  }

  const names = new Set<string>();
  const fields = (rawFields as unknown[]).map((item, index): ReadOnlyDomField => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(`field ${index} must be an object`);
    }
    const field = item as Record<string, unknown>;
    if (Object.keys(field).some((key) => !FIELD_KEYS.has(key))) {
      fail(`field ${index} has an unknown option`);
    }
    if (typeof field.name !== 'string' || !FIELD_NAME.test(field.name)) {
      fail(`field ${index} name must match ${FIELD_NAME.source}`);
    }
    if (names.has(field.name as string)) fail(`field name ${String(field.name)} is duplicated`);
    names.add(field.name as string);
    if (
      typeof field.selector !== 'string' ||
      field.selector.length < 1 ||
      field.selector.length > 512 ||
      field.selector.includes('\0')
    ) {
      fail(`field ${String(field.name)} selector must be 1-512 characters without NUL`);
    }
    const value = field.value;
    if (value !== 'text' && value !== 'attribute') {
      fail(`field ${String(field.name)} value must be text or attribute`);
    }
    const mode = value as 'text' | 'attribute';
    if (field.multiple !== undefined && typeof field.multiple !== 'boolean') {
      fail(`field ${String(field.name)} multiple must be boolean`);
    }

    const normalized: ReadOnlyDomField = {
      name: field.name as string,
      selector: field.selector as string,
      value: mode,
    };
    if (mode === 'attribute') {
      if (typeof field.attribute !== 'string' || !ATTRIBUTE_NAME.test(field.attribute)) {
        fail(`field ${String(field.name)} attribute name is invalid`);
      }
      normalized.attribute = field.attribute as string;
    } else if (field.attribute !== undefined) {
      fail(`field ${String(field.name)} attribute is only valid for attribute reads`);
    }
    if (field.multiple === true) normalized.multiple = true;
    return normalized;
  });

  return { fields };
}

export function createDomExtractionStep(config: unknown): ReadOnlyProgramStep {
  return {
    tool: 'chrome_javascript',
    args: {
      program: DOM_EXTRACTION_PROGRAM_ALIAS,
      config: assertReadOnlyDomConfig(config),
    },
    resultPath: '/result',
  };
}

export function programHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export const DOM_EXTRACTION_PROGRAM_HASH = programHash(DOM_EXTRACTION_PROGRAM);

export const PUBLISHED_READ_ONLY_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  'bilibili-popular-videos': '9365eeb13a6dd90bb5114282b92381b5cf5e9865a2778c1cce276924cf2d35f1',
  'bilibili-video-detail': '940f9aaeb008fbf3f1d3180cb60c6b0efd6588d74dfbca4cd1384b0a225f94b7',
  'github-issue-thread': '4e2e21ce0247a08544fd7a8ca0bce3ee84cf2e06c0086f02d9e2488b81cb05ef',
  'github-releases': '34bee85d1ab7184f5a065dc61a8faf57e680681f0dd6fb23917bdeb8a6e5b8cd',
  'github-repo-readme': '55d7de67ff423593ce21c586f0650043a50b10b60abe86d2d4835982c91c872f',
  'github-repo-search': 'dcd573dbcf66e4071186c4a69c226af984f095cac13ce5f2aca974016fe871f2',
  'mdn-search': '1ff226134f13fd1b923623887628b96256d51c9535a08f5c3df3a19a5ebb02ad',
  'npm-compare': '5785a9129d5c88e4df8a8b25745fa095e163b91eb1ee0477f58081e8a9329401',
  'reddit-post-read': 'a8db61c52d2246b417374436cab2867cf51082c73d45102040ceaec2d8264cbf',
  'reddit-subreddit-posts': 'cc9dc138b60209908aab7cb49205321ce59f480f6d744e8938e444dc230f2d0b',
  'v2ex-node-topics': 'ab6b30af79f295bae137b928a6284574f58858c63dcd3e84f597d9dda7ae11b3',
  'v2ex-topic-read': 'ee9ae86e6881e38a540d9efc51fd7282dd069195a33e700d3ae786122140b5c2',
  'x-profile-posts': 'fb0869522e1aff847a4a70c124bd42712107bb3ba2b1d061073e2faa55e41064',
  'x-search-thread': '59fb2cd25479f332563c217bad8722c388967864bc056dd6f98e970ce11d6c11',
  'x-visible-thread': '9db24745e0451e22390001e825e9fd6a229d461d52383b8caa19bea6ebc0f710',
  'youtube-search-videos': '4a4e2a8b5316920c1229815a926921527b85dd9bc0388b9dcb9708fca0d5a9c0',
  'youtube-video-read': 'b0c33f1c76499c2913461e553466a8ff648094990b8677631239b6fe5b11ace5',
});

/**
 * Previously reviewed built-in read-only program hashes retained for safe execution
 * and rollback of already-verified versions when a newer bundled revision changes
 * JavaScript and fails validation. Omit a prior hash here to explicitly revoke it.
 */
export const PREVIOUS_PUBLISHED_READ_ONLY_PROGRAMS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'bilibili-popular-videos': Object.freeze([
      '450dc01c9a427ccd7ec17c1422983b1fa8b00e87f33118c30f4763bd737943d3',
    ]),
    'bilibili-video-detail': Object.freeze([
      'd2da238b495b8980d072cdc380f9f637d20487cc847e543d66780e0bb8ec88b2',
    ]),
    'github-issue-thread': Object.freeze([
      '384e5adeab48a56892583d00d96db6f6af6a53c70aa3e13f9b0ed4e4423cde70',
    ]),
    'github-releases': Object.freeze([
      'f629eb72cf3c97505029d424eb60b65e8236b331f9a5f30a4556fd64cec34ad4',
    ]),
    'github-repo-readme': Object.freeze([
      'f9fc48e7f46d395e9eadc5ec6ac0f89f97a232ed0d4c5e47ecda16d78d09df67',
    ]),
    'github-repo-search': Object.freeze([
      '12e93f0ca4606fcc825b983bbdc00e68e1a873a36649277d838ec15abe3f48ec',
    ]),
    'mdn-search': Object.freeze([
      '533aa263b275356f18068c86d6cb1f240412f4a4dc2866fb9c5a58065cb6f17f',
    ]),
    'npm-compare': Object.freeze([
      'ead55b7b52e965c16e9902c916306f955a259ee860a78fd66981909f18e9436e',
    ]),
    'reddit-post-read': Object.freeze([
      'e40f0b8e5f99607b7ef691cfd98985500d31b82edee0d3c942ed87d0a63de8e3',
      'ef4f788eaeee0fe5ca33db705d6331726ad4cf6d739e4ab60972d949e35544b2',
    ]),
    'reddit-subreddit-posts': Object.freeze([
      '789f71122d0772072cda01d718ed29f97dfbeb49f84643b1935972e9013e75b3',
    ]),
    'v2ex-node-topics': Object.freeze([
      'a5dfb4036c8107c02a58e61d29af7f1d86c3a59f5969d3b0d45221e6c913f95b',
    ]),
    'v2ex-topic-read': Object.freeze([
      '9477b4a08c9debbdf09c02d2a546bf4d958c24ddfd2bd65e941569b5dc4954fb',
    ]),
    'x-profile-posts': Object.freeze([
      'f4fed984860f39f7c28f798df0a878c1224a8a0b3551834f72f02eff9d244b14',
      '0df6ed3703aec5713946014de767236c67bddce4092ea1c9426d647c21a7bdb2',
    ]),
    'x-search-thread': Object.freeze([
      'f92986d0c7d618296abcb4d9234dd0fcda17ab10674c7d2c1f9b1411331e8dc6',
    ]),
    'x-visible-thread': Object.freeze([
      '0ca61ddfb91bc18c7edd2ad209a485923ac2fc4c4c9a326977c06b64e014b145',
    ]),
    'youtube-search-videos': Object.freeze([
      'f5aa24d95aac9610b541590106bef037ec7833cd43f1f69ec4f1974977bf0a01',
    ]),
    'youtube-video-read': Object.freeze([
      '86ed74b0ee1a335be453bb71250cf8bccb6b1c0f8c504f8316d21ef220c696fe',
    ]),
  });
