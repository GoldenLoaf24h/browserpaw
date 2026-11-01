import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { VerificationSpec, VerificationResult } from './types';
import { tryParseCallResult } from '../browser-tasks';

const validatorProvider = new AjvJsonSchemaValidator();

export function hasConcreteAssertion(schema: any): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return true;
  if (typeof schema.pattern === 'string' && schema.pattern.length > 0) return true;
  if (typeof schema.minItems === 'number' && schema.minItems > 0) return true;

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const requiredKeys = schema.required.filter((k: any) => typeof k === 'string' && k.length > 0);
    if (requiredKeys.length > 0) {
      if (schema.properties && typeof schema.properties === 'object') {
        const hasConcreteRequired = requiredKeys.some((k: string) => {
          const propSchema = schema.properties[k];
          return propSchema ? hasConcreteAssertion(propSchema) : false;
        });
        if (hasConcreteRequired) return true;
      } else {
        return true;
      }
    }
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.every((branch: any) => hasConcreteAssertion(branch));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.every((branch: any) => hasConcreteAssertion(branch));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch: any) => hasConcreteAssertion(branch));
  }

  return false;
}

export function evaluateJsonPointer(value: unknown, jsonPointer?: string): unknown {
  if (!jsonPointer) return value;
  if (!jsonPointer.startsWith('/')) {
    throw new Error('resultPath must be a JSON pointer');
  }
  return jsonPointer
    .slice(1)
    .split('/')
    .reduce<unknown>((node, token) => {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) {
        throw new Error('output missing ' + jsonPointer);
      }
      return (node as any)[key];
    }, value);
}

export async function runVerifications(
  specs: VerificationSpec[] | undefined,
  internalCaller: (toolName: string, args: any) => Promise<any>,
  signal?: AbortSignal,
): Promise<{
  allPassed: boolean;
  results: VerificationResult[];
  error?: string;
  rawReceipt?: any;
  unmet?: boolean;
  status?: 'cancelled' | 'unknown' | 'timeout';
}> {
  const abortStatus = () =>
    signal?.reason?.name === 'TimeoutError' ? ('timeout' as const) : ('cancelled' as const);
  if (!specs || !Array.isArray(specs) || specs.length === 0) {
    return { allPassed: false, results: [], error: 'unverified' };
  }

  if (specs.length > 8) {
    return {
      allPassed: false,
      results: [],
      error: 'Too many verifications requested: ' + specs.length + ' > maximum 8',
    };
  }

  const results: VerificationResult[] = [];

  for (const spec of specs) {
    if (signal?.aborted) {
      return {
        allPassed: false,
        results,
        status: abortStatus(),
        error: 'Verification interrupted',
      };
    }

    if (spec.tool !== 'chrome_read_dom' && spec.tool !== 'chrome_network_request') {
      const err =
        'Tool "' +
        spec.tool +
        '" is not permitted for verification. Only chrome_read_dom and chrome_network_request are allowed.';
      results.push({ tool: spec.tool, pass: false, error: err });
      return { allPassed: false, results, error: err };
    }

    if (!hasConcreteAssertion(spec.expect)) {
      const err = 'Verification expect schema lacks concrete assertions.';
      results.push({ tool: spec.tool, pass: false, error: err });
      return { allPassed: false, results, error: err };
    }

    if (spec.tool === 'chrome_network_request') {
      const args = spec.args || {};
      const method = String(args.method || 'GET').toUpperCase();
      if (method !== 'GET') {
        const err =
          'Network request method "' +
          method +
          '" is not permitted for verification. Only GET is allowed.';
        results.push({ tool: spec.tool, pass: false, error: err });
        return { allPassed: false, results, error: err };
      }
      if (
        args.body !== undefined ||
        args.data !== undefined ||
        args.payload !== undefined ||
        args.postData !== undefined
      ) {
        const err = 'Network verification requests cannot contain body or write payload.';
        results.push({ tool: spec.tool, pass: false, error: err });
        return { allPassed: false, results, error: err };
      }
    }

    let rawRes: any;
    try {
      rawRes = await internalCaller(spec.tool, spec.args || {});
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      results.push({
        tool: spec.tool,
        pass: false,
        error: 'Verification tool call failed: ' + errMsg,
        receipt: err,
      });
      return {
        allPassed: false,
        results,
        error: errMsg,
        rawReceipt: err,
        status: signal?.aborted
          ? abortStatus()
          : ['cancelled', 'unknown', 'timeout'].includes(err?.status)
            ? err.status
            : undefined,
      };
    }

    const parsed = tryParseCallResult(rawRes) || {};
    const effectiveStatus = rawRes?.status || parsed.status;

    if (signal?.aborted || ['cancelled', 'unknown', 'timeout'].includes(effectiveStatus)) {
      return {
        allPassed: false,
        results,
        error: 'Verification interrupted',
        rawReceipt: rawRes,
        status: signal?.aborted ? abortStatus() : effectiveStatus,
      };
    }

    if (rawRes?.isError === true || parsed.isError === true || parsed.success === false) {
      const err = parsed.error || parsed.reason || 'Verification target returned error';
      results.push({ tool: spec.tool, pass: false, error: String(err), receipt: rawRes });
      return { allPassed: false, results, error: String(err), rawReceipt: rawRes };
    }

    if (rawRes?.coverage?.partial === true || (parsed as any).coverage?.partial === true) {
      const err = 'Verification observation was partial';
      results.push({ tool: spec.tool, pass: false, error: err, receipt: rawRes });
      return { allPassed: false, results, error: err, rawReceipt: rawRes };
    }

    const dataToInspect = Object.keys(parsed).length > 0 ? parsed : rawRes;
    let targetVal: any;
    try {
      targetVal = evaluateJsonPointer(dataToInspect, spec.resultPath);
    } catch (ptrErr: any) {
      const err = ptrErr?.message || String(ptrErr);
      results.push({ tool: spec.tool, pass: false, error: err, receipt: rawRes });
      return { allPassed: false, results, error: err, rawReceipt: rawRes };
    }

    try {
      const validate = validatorProvider.getValidator(spec.expect);
      const validationResult = validate(targetVal);
      if (!validationResult.valid) {
        const err = validationResult.errorMessage || 'JSONSchema validation failed';
        const resItem: VerificationResult = {
          tool: spec.tool,
          pass: false,
          observed: targetVal,
          error: err,
          receipt: rawRes,
        };
        results.push(resItem);
        return { allPassed: false, results, error: err, rawReceipt: rawRes, unmet: true };
      }
      results.push({ tool: spec.tool, pass: true, observed: targetVal, receipt: rawRes });
    } catch (compileErr: any) {
      const err = 'JSONSchema compilation failed: ' + (compileErr?.message || String(compileErr));
      results.push({ tool: spec.tool, pass: false, error: err, receipt: rawRes });
      return { allPassed: false, results, error: err, rawReceipt: rawRes };
    }
  }

  return { allPassed: true, results, rawReceipt: results[results.length - 1]?.receipt };
}
