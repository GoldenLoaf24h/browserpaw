import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = addFormats(new Ajv({ strict: false, validateSchema: false, allErrors: true }));

export const validator = {
  getValidator(schema: object) {
    const validate = ajv.compile(schema);
    return (value: unknown) => ({
      valid: validate(value),
      errorMessage: ajv.errorsText(validate.errors),
    });
  },
};
