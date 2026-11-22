import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

const ajv = addFormats(new Ajv({ strict: false, validateSchema: false, allErrors: true }));
const defaultingAjv = addFormats(
  new Ajv({ strict: false, validateSchema: false, allErrors: true, useDefaults: true }),
);
const compiledValidators = new WeakMap<object, ValidateFunction>();
const compiledDefaultingValidators = new WeakMap<object, ValidateFunction>();

function compileCached(
  instance: Ajv,
  cache: WeakMap<object, ValidateFunction>,
  schema: object,
): ValidateFunction {
  let validate = cache.get(schema);
  if (!validate) {
    validate = instance.compile(schema);
    cache.set(schema, validate);
  }
  return validate;
}

export const validator = {
  getValidator(schema: object) {
    const validate = compileCached(ajv, compiledValidators, schema);
    return (value: unknown) => ({
      valid: validate(value),
      errorMessage: ajv.errorsText(validate.errors),
    });
  },
  getDefaultingValidator(schema: object) {
    const validate = compileCached(defaultingAjv, compiledDefaultingValidators, schema);
    return (value: unknown) => ({
      valid: validate(value),
      errorMessage: defaultingAjv.errorsText(validate.errors),
    });
  },
};
