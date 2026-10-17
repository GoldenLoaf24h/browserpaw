import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeValue, sanitizeAndLimitOutput } from '../utils/output-sanitizer';

describe('Output Sanitizer Regression & False-Positive Tests', () => {
  describe('1. Security Redaction Tests (Must retain strict protection)', () => {
    it('blocks standalone cookie/query string data', () => {
      const cookieStr = 'session_id=xyz12345; path=/; HttpOnly';
      const res = sanitizeText(cookieStr);
      expect(res.text).toBe('[BLOCKED: Cookie/query string data]');
      expect(res.redacted).toBe(true);
    });

    it('redacts standalone Bearer tokens', () => {
      const input = 'Bearer secret-bearer-token-123456';
      const res = sanitizeText(input);
      expect(res.text).toBe('Bearer <redacted>');
      expect(res.redacted).toBe(true);
    });

    it('redacts 3-part JWT tokens', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const res = sanitizeText(jwt);
      expect(res.text).toContain('<redacted_jwt>');
      expect(res.redacted).toBe(true);
    });

    it('redacts sensitive query params in long URLs', () => {
      const url =
        'https://api.example.com/v1/resource/query?token=secret123&client_id=12345&region=us-east-1&format=json&debug=false&filter=all&timestamp=1700000000&session_flag=true&analytics=enabled&cache_control=no-cache&version=2026.1&app_name=browserpaw_production_system';
      const res = sanitizeText(url);
      expect(res.text).toContain('token=<redacted>');
      expect(res.redacted).toBe(true);
    });

    it('redacts header-like sensitive key-value pairs', () => {
      const header = 'x-api-key: my-secret-api-key-999';
      const res = sanitizeText(header);
      expect(res.text).toContain('x-api-key=<redacted>');
      expect(res.redacted).toBe(true);
    });

    it('redacts quoted header-like and JSON string sensitive key-value pairs', () => {
      const jsonStr = '{"apiKey": "mySecretHexToken1234567890abcdef", "secret": "topSecret123"}';
      const res = sanitizeText(jsonStr);
      expect(res.text).toContain('apiKey=<redacted>');
      expect(res.text).toContain('secret=<redacted>');
      expect(res.redacted).toBe(true);
    });

    it('blocks explicit whole-string Base64 data with trailing padding', () => {
      // 32-char valid base64 payload ending with '='
      const b64 = 'SGVsbG8gV29ybGQhISEhISEhISEhISE=';
      const res = sanitizeText(b64);
      expect(res.text).toBe('[BLOCKED: Base64 encoded data]');
      expect(res.redacted).toBe(true);
    });

    it('blocks explicit whole-string Base64 data containing + and / without padding', () => {
      // 24-char valid unpadded base64 payload with + and /
      const b64 = '+//v'.repeat(6);
      const res = sanitizeText(b64);
      expect(res.text).toBe('[BLOCKED: Base64 encoded data]');
      expect(res.redacted).toBe(true);
    });

    it('redacts embedded base64 data in mixed content', () => {
      const mixed =
        'Token payload is SGVsbG8rV29ybGQvQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo= inside response';
      const res = sanitizeText(mixed);
      expect(res.text).toContain('<redacted_base64>');
      expect(res.redacted).toBe(true);
    });

    it('still redacts embedded Base64 payloads with padding or + markers (D-08)', () => {
      const paddedSlash = 'blob MxvLoHCIYlWF/a32UYvZPTkFzbmeWJYaChkhlvIAMgvInA== end';
      const plusOnly = `blob ${'+//v'.repeat(11)} end`;
      for (const input of [paddedSlash, plusOnly]) {
        const res = sanitizeText(input);
        expect(res.text).toContain('<redacted_base64>');
        expect(res.redacted).toBe(true);
      }
    });

    it('redacts unpadded slash-only Base64 payloads of any length modulo 4', () => {
      // Real Base64 of 'username=admin; password=hunter!?' (44 chars, len % 4 === 0),
      // '...hunter ? ' (46 chars, len % 4 === 2), '...hunter ?  ' (47 chars, len % 4 === 3).
      // Each contains '/' but no '+', so '/' alone must stay a structural marker.
      const samples = [
        ['dXNlcm5hbWU9YWRtaW47IHBhc3N3b3JkPWh1bnRlciE/', 'username=admin; password=hunter!?'],
        ['dXNlcm5hbWU9YWRtaW47IHBhc3N3b3JkPWh1bnRlciA/IA', 'username=admin; password=hunter ? '],
        ['dXNlcm5hbWU9YWRtaW47IHBhc3N3b3JkPWh1bnRlciA/ICA', 'username=admin; password=hunter ?  '],
      ];
      for (const [slashOnly, decoded] of samples) {
        expect(slashOnly).not.toContain('+');
        expect(slashOnly).not.toMatch(/=$/);
        expect(Buffer.from(slashOnly, 'base64').toString()).toBe(decoded);
        for (const input of [slashOnly, `payload ${slashOnly} end`]) {
          const res = sanitizeText(input);
          expect(res.text).not.toContain(slashOnly);
          expect(res.redacted).toBe(true);
        }
      }
    });

    it('does not let an unrelated URL hide a later slash-only Base64 payload', () => {
      const slashOnly = 'dXNlcm5hbWU9YWRtaW47IHBhc3N3b3JkPWh1bnRlciE/';
      const res = sanitizeText(`see https://a.example/x and token ${slashOnly}`);
      expect(res.text).not.toContain(slashOnly);
      expect(res.redacted).toBe(true);
    });

    it('redacts an embedded slash-leading Base64 payload (leading / is not a path)', () => {
      // Real Base64 (33 bytes -> 44 chars) starting with '/', no '+' and no padding.
      const slashLeading = '/CAgNTxDSlFYX2ZtdHsjKjE4P0ZNVFtiaXB3fiYtNDtC';
      expect(Buffer.from(slashLeading, 'base64').toString('base64')).toBe(slashLeading);
      const res = sanitizeText(`payload ${slashLeading} end`);
      expect(res.text).not.toContain(slashLeading);
      expect(res.redacted).toBe(true);
    });
  });

  describe('2. False-Positive Prevention Tests (Must NOT redact non-sensitive identifiers/hashes)', () => {
    it('does NOT block long camelCase identifiers as whole string (MOTION-02)', () => {
      const identifier = 'thisIsAVeryLongVariableNameForTesting';
      const res = sanitizeText(identifier);
      expect(res.text).toBe(identifier);
      expect(res.redacted).toBe(false);
    });

    it('does NOT block long natural words or technical class names', () => {
      const className = 'AbstractAnnotationConfigDispatcherServletInitializer';
      const res = sanitizeText(className);
      expect(res.text).toBe(className);
      expect(res.redacted).toBe(false);
    });

    it('does NOT redact long class names embedded in log lines', () => {
      const logLine =
        'Loaded class AbstractAnnotationConfigDispatcherServletInitializer successfully';
      const res = sanitizeText(logLine);
      expect(res.text).toBe(logLine);
      expect(res.redacted).toBe(false);
    });

    it('does NOT block Git commit SHA-1 (40-char hex) as whole string', () => {
      const commitSha = 'c3ab8ff13720e8ad9047dd39466b3c8974e592c2';
      const res = sanitizeText(commitSha);
      expect(res.text).toBe(commitSha);
      expect(res.redacted).toBe(false);
    });

    it('does NOT redact Git commit SHA-1 embedded in log messages', () => {
      const logMsg = 'commit c3ab8ff13720e8ad9047dd39466b3c8974e592c2 was merged into main';
      const res = sanitizeText(logMsg);
      expect(res.text).toBe(logMsg);
      expect(res.redacted).toBe(false);
    });

    it('does NOT block 32-char MD5 hashes without credential context', () => {
      const md5 = '098f6bcd4621d373cade4e832627b4f6';
      const res = sanitizeText(md5);
      expect(res.text).toBe(md5);
      expect(res.redacted).toBe(false);
    });

    it('does NOT redact long absolute paths or deep URLs (D-08)', () => {
      const preserved = [
        'some/very/long/filesystem/path/to/the/target/directory',
        'C:/Users/Lenovo/AppData/Local/Temp/browserpaw-audit-20261014',
        'https://cdn.example.com/assets/product/hero/image/renditions/large',
      ];
      for (const input of preserved) {
        const res = sanitizeText(input);
        expect(res.text).toBe(input);
        expect(res.redacted).toBe(false);
      }
    });

    it('keeps path/URL context even when the slash chunk has Base64-compatible length', () => {
      // The slash-delimited chunks below have length % 4 of 0, 2, or 3; they
      // must still be treated as paths rather than unpadded Base64 payloads.
      const preserved = [
        'C:/Users/Lenovo/AppData/Local/Temp/browserpawaudit20261017',
        'C:/Users/Lenovo/AppData/Local/Temp/browserpawaudit2026101',
        'https://cdn.example.com/assets/product/hero/image/renditions/largeAB',
        './some/very/long/filesystem/path/to/the/target/directory',
      ];
      for (const input of preserved) {
        const res = sanitizeText(input);
        expect(res.text).toBe(input);
        expect(res.redacted).toBe(false);
      }
    });

    it('fail-closed tradeoff: bare absolute paths of Base64-alphabet chars are redacted', () => {
      // A bare leading '/' is also a valid Base64 first character and a
      // relative path made only of Base64 characters cannot be distinguished
      // from a payload, so such chunks are redacted on purpose.
      const bareAbsolute = '/srv/app/releases/current/public/assets/images/hero';
      const res = sanitizeText(bareAbsolute);
      expect(res.text).toContain('<redacted_base64>');
      expect(res.redacted).toBe(true);
    });

    it('does NOT redact benign keys containing short marker substrings (D-09)', () => {
      const payload = {
        author: 'Ada Lovelace',
        aside: 'sidebar note',
        president: 'Grace Hopper',
        considered: true,
        autocomplete: 'on',
      };
      const result = sanitizeValue(payload);
      expect(result.redacted).toBe(false);
      expect(result.value).toEqual(payload);
    });

    it('does NOT redact benign camelCase keys starting with acronym-like runs', () => {
      const payload = {
        presidentName: 'Grace Hopper',
        authorBio: 'Compiler pioneer',
        XMLHttpRequest: 'ready',
        userID: 'user_4096',
        publicURL: 'https://example.com/profile',
      };
      const result = sanitizeValue(payload);
      expect(result.redacted).toBe(false);
      expect(result.value).toEqual(payload);
    });
  });

  describe('3. Contextual Object & Value Redaction Tests (sanitizeValue & sanitizeAndLimitOutput)', () => {
    it('redacts Hex keys and Base64 tokens when placed under sensitive object fields', () => {
      const rawObject = {
        token: '4f53c2b1a09876543210fedcba987654', // Hex credential in token field
        password: 'plain_password_123',
        apiKey: '+//v'.repeat(6), // Base64 in apiKey field
        normalIdentifier: 'thisIsAVeryLongVariableNameForTesting',
        commitSha: 'c3ab8ff13720e8ad9047dd39466b3c8974e592c2',
        metadata: {
          session: 'active_session_token_xyz',
          publicId: 'user_4096_profile',
        },
      };

      const result = sanitizeValue(rawObject, {
        maxDepth: 6,
        maxArrayLength: 50,
        maxObjectKeys: 50,
        maxStringLength: 1000,
      });

      expect(result.redacted).toBe(true);
      const sanitized = result.value as Record<string, any>;

      // Sensitive fields must be replaced by <redacted> regardless of string format
      expect(sanitized.token).toBe('<redacted>');
      expect(sanitized.password).toBe('<redacted>');
      expect(sanitized.apiKey).toBe('<redacted>');
      expect(sanitized.metadata.session).toBe('<redacted>');

      // Non-sensitive fields must be completely preserved
      expect(sanitized.normalIdentifier).toBe('thisIsAVeryLongVariableNameForTesting');
      expect(sanitized.commitSha).toBe('c3ab8ff13720e8ad9047dd39466b3c8974e592c2');
      expect(sanitized.metadata.publicId).toBe('user_4096_profile');
    });

    it('formats and preserves structure while ensuring credential safety in sanitizeAndLimitOutput', () => {
      const payload = {
        auth: 'Bearer my-top-secret-token',
        commit: 'c3ab8ff13720e8ad9047dd39466b3c8974e592c2',
        serviceName: 'AbstractAnnotationConfigDispatcherServletInitializer',
      };

      const output = sanitizeAndLimitOutput(payload, { maxBytes: 5000 });
      expect(output.redacted).toBe(true);
      const parsed = JSON.parse(output.text);
      expect(parsed.auth).toBe('<redacted>');
      expect(parsed.commit).toBe('c3ab8ff13720e8ad9047dd39466b3c8974e592c2');
      expect(parsed.serviceName).toBe('AbstractAnnotationConfigDispatcherServletInitializer');
    });

    it('still redacts genuine short-marker keys (D-09)', () => {
      const payload = {
        auth: 'Bearer abc',
        sid: 'abc123',
        user_sid: 'abc123',
        oauthState: 'xyz',
        csrfToken: 'tok',
        sessionId: 'sess',
      };
      const result = sanitizeValue(payload);
      const out = result.value as Record<string, unknown>;
      for (const key of Object.keys(payload)) {
        expect(out[key]).toBe('<redacted>');
      }
      expect(result.redacted).toBe(true);
    });

    it('redacts acronym-prefixed camelCase sensitive keys (XSRFHeader, CSRFToken, APIKey)', () => {
      const payload = {
        XSRFHeader: 'xsrf-header-value',
        CSRFToken: 'csrf-token-value',
        APIKey: 'api-key-value',
        OAuthToken: 'oauth-token-value',
      };
      const result = sanitizeValue(payload);
      const out = result.value as Record<string, unknown>;
      for (const key of Object.keys(payload)) {
        expect(out[key]).toBe('<redacted>');
      }
      expect(result.redacted).toBe(true);
    });
    it('serializes diamond-shaped DAG references without [Circular] (D-09)', () => {
      const shared = { label: 'shared node' };
      const result = sanitizeValue({ a: shared, b: shared, list: [shared] });
      const out = result.value as any;
      expect(out.a).toEqual({ label: 'shared node' });
      expect(out.b).toEqual({ label: 'shared node' });
      expect(out.list[0]).toEqual({ label: 'shared node' });
      expect(JSON.stringify(result.value)).not.toContain('[Circular]');
    });

    it('still marks genuine cycles, including inside shared nodes (D-09)', () => {
      const cyclic: any = { name: 'root' };
      cyclic.self = cyclic;
      const cycleOut = sanitizeValue(cyclic).value as any;
      expect(cycleOut.name).toBe('root');
      expect(cycleOut.self).toBe('[Circular]');

      const shared: any = { label: 'shared' };
      shared.self = shared;
      const dagOut = sanitizeValue({ a: shared, b: shared }).value as any;
      expect(dagOut.a.label).toBe('shared');
      expect(dagOut.a.self).toBe('[Circular]');
      expect(dagOut.b.label).toBe('shared');
      expect(dagOut.b.self).toBe('[Circular]');
    });
  });
});
