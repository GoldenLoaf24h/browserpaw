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
  'github-releases': 'f629eb72cf3c97505029d424eb60b65e8236b331f9a5f30a4556fd64cec34ad4',
  'mdn-search': '533aa263b275356f18068c86d6cb1f240412f4a4dc2866fb9c5a58065cb6f17f',
  'npm-compare': 'ead55b7b52e965c16e9902c916306f955a259ee860a78fd66981909f18e9436e',
  'x-search-thread': 'f92986d0c7d618296abcb4d9234dd0fcda17ab10674c7d2c1f9b1411331e8dc6',
  'x-visible-thread': '0ca61ddfb91bc18c7edd2ad209a485923ac2fc4c4c9a326977c06b64e014b145',
});
