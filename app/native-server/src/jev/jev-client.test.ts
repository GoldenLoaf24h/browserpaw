import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import {
  isSensitiveElement,
  buildState,
  validateChoice,
  extractTextPayload,
  isDestructiveTarget,
  getTop3Probabilities,
  isSessionKeyInvalid,
  latchInvalidKey,
  resetInvalidKeyLatch,
  DESTRUCTIVE_KEYWORDS,
  JevClientWrapper,
  extractVisualTargetDescription,
  parseScreenshotContent,
  validateBoxCoordinates,
  supportsBoxQuestions,
  DANGER_ZONE_IMAGES_HEADER,
} from './jev-client';
import { jevModelManager } from '../server/jev-model-manager';

/**
 * These suites describe a fixed machine: the credential comes from the environment and
 * the local decider is not installed.
 *
 * On a machine with a real model in `~/.browserpaw/models`, `JevModelManager` starts with
 * no API key and no environment credential, so it self-switches `activeMode` to `local`
 * and every remote-path assertion below is silently routed to the offline local service.
 * The developer's saved configuration must not decide what these tests measure.
 *
 * Bound before any spy is installed so the wrapper always calls the real implementation.
 */
const realGetRemoteConfig = jevModelManager.getRemoteConfig.bind(jevModelManager);

function pinTestEnvironment(): void {
  jest
    .spyOn(jevModelManager, 'getRemoteConfig')
    .mockImplementation(() => ({ ...realGetRemoteConfig(), apiKey: undefined }));
  jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote');
  jest.spyOn(jevModelManager, 'isModelDownloaded').mockReturnValue(false);
}

describe('Jev Client & Helper Unit Tests', () => {
  beforeEach(() => {
    resetInvalidKeyLatch();
    pinTestEnvironment();
  });

  describe('1. Sensitive element filtering', () => {
    test('filters password inputs and file uploads', () => {
      expect(isSensitiveElement('[1] password "Password"')).toBe(true);
      expect(isSensitiveElement('[2] input type="password"')).toBe(true);
      expect(isSensitiveElement('[3] file "Upload Avatar"')).toBe(true);
      expect(isSensitiveElement('[4] input type="file"')).toBe(true);
      expect(isSensitiveElement('[5] textbox role="password"')).toBe(true);

      expect(isSensitiveElement('[6] button "Sign in"')).toBe(false);
      expect(isSensitiveElement('[7] textbox "Username"')).toBe(false);
      expect(isSensitiveElement('[8] link "Forgot password?"')).toBe(false); // plain link, not an input
      expect(isSensitiveElement('[9] textbox "Password" type="password"')).toBe(true);
    });
  });

  describe('2. State assembly and budget enforcement (§5.1)', () => {
    test('assembles state within line length, count, and total character limits', () => {
      const longLine = 'A'.repeat(200);
      const lines = Array.from({ length: 300 }, (_, i) => `[${i}] button "${longLine}"`);
      lines.push('[999] password "Secret"');

      const history = Array.from({ length: 10 }, (_, i) => ({
        step: i + 1,
        action: `click [${i}]`,
        outcome: 'urlChanged:false, mutated:true',
      }));

      const state = buildState(
        'Test Goal',
        'https://example.com/very/long/url',
        'Sample Page Title',
        lines,
        history,
        'dialog "User Agreement"',
      );

      expect(state.task).toBe('Test Goal');
      expect(state.page.url).toBe('https://example.com/very/long/url');
      expect(state.page.title).toBe('Sample Page Title');
      expect(state.pending_modal).toBe('dialog "User Agreement"');

      // <= 250 elements
      expect(state.elements.length).toBeLessThanOrEqual(250);

      // single line <= 120 chars
      for (const el of state.elements) {
        expect(el.length).toBeLessThanOrEqual(120);
      }

      // sensitive elements stripped
      expect(state.elements.some((el) => el.includes('password'))).toBe(false);

      // history <= 5 recent items
      expect(state.history.length).toBe(5);
      expect(state.history[0].step).toBe(6);
      expect(state.history[4].step).toBe(10);

      // total JSON string <= 24,000 characters
      expect(JSON.stringify(state).length).toBeLessThanOrEqual(24000);
    });

    test('P1: carries visible page text so a rendered result is observable', () => {
      const lines = ['[1] textbox "Search query" value="BrowserPaw"'];

      // The outcome of a control action is usually page text, not another control; without it
      // the model cannot tell that the goal was reached.
      const withText = buildState(
        'Filter the list',
        'https://example.com/search',
        'Products',
        lines,
        [],
        undefined,
        'Preview: BrowserPaw\nBrowserPaw Automation Engine',
      );
      expect(withText.page_text).toContain('Preview: BrowserPaw');

      // Absent text must not add an empty field to the payload.
      const withoutText = buildState(
        'Filter the list',
        'https://example.com/search',
        'Products',
        lines,
        [],
        undefined,
        undefined,
      );
      expect(withoutText).not.toHaveProperty('page_text');
    });

    test('P1: page text is dropped before element indices when the budget is exceeded', () => {
      const lines = Array.from({ length: 250 }, (_, i) => `[${i + 1}] button "Item ${i + 1}"`);
      const state = buildState(
        'Click through the list',
        'https://example.com/list',
        'List',
        lines,
        [],
        undefined,
        'x'.repeat(6000),
      );

      expect(JSON.stringify(state).length).toBeLessThanOrEqual(24000);
      // Element indices are what every action question refers to, so they survive longest.
      expect(state.elements.length).toBeGreaterThan(0);
      expect(state.elements[0]).toContain('[1]');
    });
  });

  describe('4. validateChoice full branch verification (§5.5)', () => {
    const validKeys = ['click', 'type', 'done'];

    test('accepts valid choice with normalized probability distribution', () => {
      const validAnswer = {
        type: 'choice',
        choice: 'click',
        confidence: 0.85,
        probabilities: {
          click: 0.85,
          type: 0.1,
          done: 0.05,
        },
      };
      expect(validateChoice(validAnswer, validKeys)).toBe(true);
    });

    test('rejects non-choice type or missing object', () => {
      expect(validateChoice(null, validKeys)).toBe(false);
      expect(validateChoice({ type: 'noul', noul: 0.9 }, validKeys)).toBe(false);
    });

    test('rejects choice not in expected keys', () => {
      const invalid = {
        type: 'choice',
        choice: 'unknown_action',
        confidence: 1.0,
        probabilities: { unknown_action: 1.0 },
      };
      expect(validateChoice(invalid, validKeys)).toBe(false);
    });

    test('rejects mismatched probability keys (missing or extra)', () => {
      const missingKey = {
        type: 'choice',
        choice: 'click',
        probabilities: { click: 0.9, type: 0.1 }, // missing 'done'
      };
      expect(validateChoice(missingKey, validKeys)).toBe(false);

      const extraKey = {
        type: 'choice',
        choice: 'click',
        probabilities: { click: 0.8, type: 0.1, done: 0.05, extra: 0.05 },
      };
      expect(validateChoice(extraKey, validKeys)).toBe(false);
    });

    test('rejects probability out of bounds (< 0 or > 1 or NaN)', () => {
      const negative = {
        type: 'choice',
        choice: 'click',
        probabilities: { click: 1.2, type: -0.2, done: 0.0 },
      };
      expect(validateChoice(negative, validKeys)).toBe(false);
    });

    test('rejects sum deviating beyond 1 +/- 0.02', () => {
      const lowSum = {
        type: 'choice',
        choice: 'click',
        probabilities: { click: 0.5, type: 0.2, done: 0.1 }, // sum 0.80
      };
      expect(validateChoice(lowSum, validKeys)).toBe(false);

      const highSum = {
        type: 'choice',
        choice: 'click',
        probabilities: { click: 0.7, type: 0.3, done: 0.1 }, // sum 1.10
      };
      expect(validateChoice(highSum, validKeys)).toBe(false);

      // Within tolerance: sum = 0.99
      const tolSum = {
        type: 'choice',
        choice: 'click',
        probabilities: { click: 0.59, type: 0.2, done: 0.2 },
      };
      expect(validateChoice(tolSum, validKeys)).toBe(true);
    });

    test('rejects winning choice if it does not have the maximum probability', () => {
      const notMax = {
        type: 'choice',
        choice: 'type', // type is 0.3, but click is 0.6
        probabilities: { click: 0.6, type: 0.3, done: 0.1 },
      };
      expect(validateChoice(notMax, validKeys)).toBe(false);
    });
  });

  describe('5. Text payload extraction (§5.4)', () => {
    test('extracts from quotes (English and Chinese)', () => {
      expect(extractTextPayload('在搜索框中输入"BrowserPaw"')).toBe('BrowserPaw');
      expect(extractTextPayload('输入“深度学习”并提交')).toBe('深度学习');
      expect(extractTextPayload('在输入框输入‘我的密码’')).toBe('我的密码');
      expect(extractTextPayload("search for 'TypeScript'")).toBe('TypeScript');
      expect(extractTextPayload('在输入框填入「人工智能」')).toBe('人工智能');
    });

    test('uses textHint when no quotes are present', () => {
      expect(extractTextPayload('请填写用户名', 'my_username')).toBe('my_username');
    });

    test('extracts trailing phrase after keywords', () => {
      expect(extractTextPayload('搜索 BrowserPaw 插件')).toBe('BrowserPaw 插件');
      expect(extractTextPayload('type: hello_world into field')).toBe('hello_world');
      expect(extractTextPayload('输入 user@test.com 到邮箱')).toBe('user@test.com');
      expect(extractTextPayload('type mechanical keyboard into searchbox')).toBe(
        'mechanical keyboard',
      );
      expect(extractTextPayload('Click button for next page')).toBeNull();
    });

    test('returns null when text is unclear', () => {
      expect(extractTextPayload('点击登录按钮')).toBeNull();
      expect(extractTextPayload('')).toBeNull();
    });
  });

  describe('6. Destructive keywords verification (§2.3)', () => {
    test('detects all 16 built-in destructive keywords including send and publish', () => {
      expect(DESTRUCTIVE_KEYWORDS).toHaveLength(16);
      for (const kw of DESTRUCTIVE_KEYWORDS) {
        expect(isDestructiveTarget(`[1] button "${kw}"`)).toBe(true);
        expect(isDestructiveTarget(`Confirm ${kw.toUpperCase()} action`)).toBe(true);
      }
      expect(isDestructiveTarget('[2] button "Next Step"')).toBe(false);
      expect(isDestructiveTarget('[3] link "Learn More"')).toBe(false);
      expect(isDestructiveTarget('[4] textbox "Postal Code"')).toBe(false);
      expect(isDestructiveTarget('[5] textbox "Company Poster"')).toBe(false);
      expect(isDestructiveTarget('[6] button "Deposit Funds"')).toBe(false);
      expect(isDestructiveTarget('[7] textbox "Confirmation Number"')).toBe(false);
      expect(isDestructiveTarget('[8] button "Prepaid Card"')).toBe(false);
      expect(isDestructiveTarget('[9] button "pay_now"')).toBe(true);
      expect(isDestructiveTarget('[10] button "btn_pay_now"')).toBe(true);
      expect(isDestructiveTarget('[11] button "submit_order"')).toBe(true);
      expect(isDestructiveTarget('[12] button "delete_account"')).toBe(true);
      expect(isDestructiveTarget('[13] button "confirm-order"')).toBe(true);
      expect(isDestructiveTarget('[14] button "pay-now"')).toBe(true);
      expect(isDestructiveTarget('[15] button "repay"')).toBe(false);
      expect(isDestructiveTarget('[16] textbox "taxpayer"')).toBe(false);
    });

    test('matches visible text only, never id/class/href (kebab-case false positives)', () => {
      // Reddit "Add tags" button: benign label, but id "#reddit-post-flair-button"
      // contains kebab-case "post" that must NOT be treated as destructive.
      expect(isDestructiveTarget('[20] button "Add tags" #reddit-post-flair-button')).toBe(false);
      expect(isDestructiveTarget('[21] textbox "Title" #post-title')).toBe(false);
      expect(isDestructiveTarget('[22] link "View Comments" #post-comments-count')).toBe(false);
      expect(isDestructiveTarget('[23] button "Cancel" #post-cancel-btn')).toBe(false);

      // Real destructive visible text still blocks reliably.
      expect(isDestructiveTarget('[24] button "Post" #reddit-post-flair-button')).toBe(true);
      expect(isDestructiveTarget('[25] button "Submit Post" #btn-123')).toBe(true);
      expect(isDestructiveTarget('[26] button "发布" #post-btn')).toBe(true);
      expect(isDestructiveTarget('[27] button "Send"')).toBe(true);
      expect(isDestructiveTarget('[28] button "Publish"')).toBe(true);
      expect(isDestructiveTarget('[29] button "Send Message"')).toBe(true);
      expect(isDestructiveTarget('[30] button "Publish Post"')).toBe(true);
      expect(isDestructiveTarget('[31] button "sender"')).toBe(false);
      expect(isDestructiveTarget('[32] button "publisher"')).toBe(false);
    });
  });

  describe('7. Top-3 probability distribution (§5.6)', () => {
    test('extracts and sorts top 3 probabilities', () => {
      const probs = {
        alpha: 0.1,
        gamma: 0.65,
        delta: 0.05,
        beta: 0.2,
      };
      const top3 = getTop3Probabilities(probs);
      expect(Object.keys(top3)).toEqual(['gamma', 'beta', 'alpha']);
      expect(top3['gamma']).toBe(0.65);
      expect(top3['beta']).toBe(0.2);
      expect(top3['alpha']).toBe(0.1);
    });
  });

  describe('8. Session-level 401 latch (§4.2)', () => {
    test('latches invalid key state', () => {
      expect(isSessionKeyInvalid()).toBe(false);
      latchInvalidKey();
      expect(isSessionKeyInvalid()).toBe(true);
      resetInvalidKeyLatch();
      expect(isSessionKeyInvalid()).toBe(false);
    });
  });

  describe('9. JevClientWrapper query error classification (§4.2)', () => {
    test('returns invalid_key and latches key on 401 AuthenticationError', async () => {
      const client = new JevClientWrapper('dummy_key');
      // Mock client.systemOne throwing 401
      (client as any).client = {
        systemOne: async () => {
          const err: any = new Error('Unauthorized');
          err.status = 401;
          throw err;
        },
      };

      const res = await client.query(
        { task: 'test', page: { url: '', title: '' }, elements: [], history: [] },
        {},
      );

      expect(res.errorReason).toBe('invalid_key');
      expect(isSessionKeyInvalid()).toBe(true);
      expect(client.isAvailable()).toBe(false);
    });

    test('returns quota_exhausted on 429 without latching key', async () => {
      resetInvalidKeyLatch();
      const client = new JevClientWrapper('dummy_key');
      (client as any).client = {
        systemOne: async () => {
          const err: any = new Error('Too Many Requests');
          err.status = 429;
          throw err;
        },
      };

      const res = await client.query(
        { task: 'test', page: { url: '', title: '' }, elements: [], history: [] },
        {},
      );

      expect(res.errorReason).toBe('quota_exhausted');
      expect(isSessionKeyInvalid()).toBe(false);
    });

    test('returns network_error on connection timeout or network abort', async () => {
      resetInvalidKeyLatch();
      const client = new JevClientWrapper('dummy_key');
      (client as any).client = {
        systemOne: async () => {
          const err: any = new Error('Connection refused');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      };

      const res = await client.query(
        { task: 'test', page: { url: '', title: '' }, elements: [], history: [] },
        {},
      );

      expect(res.errorReason).toBe('network_error');
      expect(isSessionKeyInvalid()).toBe(false);
    });
  });

  describe('10. scoreOptions shortlisting and usage return (§2.3, §5.2)', () => {
    test('returns null without sending request when options exceed 32 or empty', async () => {
      const client = new JevClientWrapper('dummy_key');
      let callCount = 0;
      (client as any).client = {
        systemOne: async () => {
          callCount++;
          return {};
        },
      };

      const over32 = Array.from({ length: 33 }, (_, i) => ({
        text: 'Opt ' + i,
        value: 'val_' + i,
      }));
      expect(await client.scoreOptions('Select something', over32)).toBeNull();
      expect(await client.scoreOptions('Select something', [])).toBeNull();
      expect(callCount).toBe(0);
    });

    test('does not truncate >20 options, includes all candidates plus none in choice criteria', async () => {
      const client = new JevClientWrapper('dummy_key');
      const options25 = Array.from({ length: 25 }, (_, i) => ({
        text: 'State ' + i,
        value: 'ST_' + i,
      }));
      let capturedCriteria: Record<string, string> = {};

      (client as any).client = {
        systemOne: async (req: any) => {
          capturedCriteria = req.questions.select_option.criteria;
          const keys = Object.keys(capturedCriteria);
          const probs: Record<string, number> = {};
          keys.forEach((k) => {
            probs[k] = k === '24' ? 0.9 : 0.1 / (keys.length - 1);
          });
          return {
            model: 'jev-latest',
            answers: {
              select_option: {
                type: 'choice',
                choice: '24',
                confidence: 0.9,
                probabilities: probs,
              },
            },
            usage: { input_tokens: 420, output_tokens: 15 },
          };
        },
      };

      const result = await client.scoreOptions('Select last state', options25);
      expect(Object.keys(capturedCriteria).length).toBe(26); // 25 options + 'none'
      expect(capturedCriteria).toHaveProperty('none');
      expect(result).not.toBeNull();
      expect(result!.bestIndex).toBe(24);
      expect(result!.bestOption.text).toBe('State 24');
      expect(result!.confidence).toBe(0.9);
      expect(result!.usage?.inputTokens).toBe(420);
      expect(result!.usage?.outputTokens).toBe(15);
    });

    test('single option evaluates via Jev with none support rather than picking blindly', async () => {
      const client = new JevClientWrapper('dummy_key');
      const single = [{ text: 'Delete Account', value: 'del' }];

      // Case A: Jev resolves to none -> returns null
      (client as any).client = {
        systemOne: async (req: any) => {
          expect(Object.keys(req.questions.select_option.criteria)).toEqual(['0', 'none']);
          return {
            model: 'jev-latest',
            answers: {
              select_option: {
                type: 'choice',
                choice: 'none',
                confidence: 0.95,
                probabilities: { '0': 0.05, none: 0.95 },
              },
            },
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        },
      };
      const noneResult = await client.scoreOptions('Search flights', single);
      expect(noneResult).toBeNull();

      // Case B: Jev resolves to option 0 with high confidence -> returns option
      (client as any).client = {
        systemOne: async () => ({
          model: 'jev-latest',
          answers: {
            select_option: {
              type: 'choice',
              choice: '0',
              confidence: 0.92,
              probabilities: { '0': 0.92, none: 0.08 },
            },
          },
          usage: { input_tokens: 120, output_tokens: 12 },
        }),
      };
      const matchResult = await client.scoreOptions('Delete my profile account', single);
      expect(matchResult).not.toBeNull();
      expect(matchResult!.bestIndex).toBe(0);
      expect(matchResult!.bestOption.value).toBe('del');
      expect(matchResult!.confidence).toBe(0.92);
    });

    test('enforces confidence >= 0.85 and top gap >= 0.20 thresholds', async () => {
      const client = new JevClientWrapper('dummy_key');
      const options = [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' },
      ];

      // Low confidence (< 0.85) -> null
      (client as any).client = {
        systemOne: async () => ({
          model: 'jev-latest',
          answers: {
            select_option: {
              type: 'choice',
              choice: '0',
              confidence: 0.8,
              probabilities: { '0': 0.8, '1': 0.15, none: 0.05 },
            },
          },
        }),
      };
      expect(await client.scoreOptions('Choose A', options)).toBeNull();

      // Narrow top gap (< 0.20) -> null (even with confidence >= 0.85 if gap is ambiguous)
      (client as any).client = {
        systemOne: async () => ({
          model: 'jev-latest',
          answers: {
            select_option: {
              type: 'choice',
              choice: '0',
              confidence: 0.86,
              probabilities: { '0': 0.55, '1': 0.4, none: 0.05 },
            },
          },
        }),
      };
      expect(await client.scoreOptions('Choose A', options)).toBeNull();
    });

    test('rejects legacy score format, missing confidence, and invalid choice without default 0 fallback', async () => {
      const client = new JevClientWrapper('dummy_key');
      const options = [
        { text: 'First', value: '1' },
        { text: 'Second', value: '2' },
      ];

      // Legacy score format
      (client as any).client = {
        systemOne: async () => ({
          model: 'jev-latest',
          answers: {
            select_option: {
              type: 'score',
              score: 0,
              probabilities: { '0': 0.9, '1': 0.1 },
            },
          },
        }),
      };
      expect(await client.scoreOptions('Choose first', options)).toBeNull();

      // Missing confidence
      (client as any).client = {
        systemOne: async () => ({
          model: 'jev-latest',
          answers: {
            select_option: {
              type: 'choice',
              choice: '0',
              probabilities: { '0': 0.95, '1': 0.05, none: 0 },
            },
          },
        }),
      };
      expect(await client.scoreOptions('Choose first', options)).toBeNull();

      // Invalid choice not in criteria
      (client as any).client = {
        systemOne: async () => ({
          model: 'jev-latest',
          answers: {
            select_option: {
              type: 'choice',
              choice: '99',
              confidence: 0.95,
              probabilities: { '0': 0.05, '1': 0.05, none: 0.9 },
            },
          },
        }),
      };
      expect(await client.scoreOptions('Choose first', options)).toBeNull();
    });

    test('respects 1500ms deadline, abort signal, disables retry, and sets unknown usage to null', async () => {
      const client = new JevClientWrapper('dummy_key');
      const options = [{ text: 'Alpha', value: 'a' }];
      let passedRequestOptions: any;

      (client as any).client = {
        systemOne: async (_req: any, opts: any) => {
          passedRequestOptions = opts;
          return {
            model: 'jev-latest',
            answers: {
              select_option: {
                type: 'choice',
                choice: '0',
                confidence: 0.95,
                probabilities: { '0': 0.95, none: 0.05 },
              },
            },
          };
        },
      };

      const result = await client.scoreOptions('Select Alpha', options, undefined, {
        timeout: 3000,
      });
      expect(result).not.toBeNull();
      expect(passedRequestOptions.timeout).toBe(1500);
      expect(passedRequestOptions.retry).toEqual({ maxRetries: 0 });
      expect(result!.usage?.inputTokens).toBeNull();
      expect(result!.usage?.outputTokens).toBeNull();

      // Already aborted signal short-circuits
      const controller = new AbortController();
      controller.abort();
      expect(
        await client.scoreOptions('Select Alpha', options, undefined, {
          signal: controller.signal,
        }),
      ).toBeNull();
    });

    test('respects global off and mode mismatch without switching backend', async () => {
      const client = new JevClientWrapper('dummy_key');
      const options = [{ text: 'Alpha', value: 'a' }];

      // If mode requested does not match active mode (active is remote, request local)
      expect(await client.scoreOptions('Select Alpha', options, 'local')).toBeNull();
    });
  });

  describe('11. Dynamic API Key Rotation & Latch Recovery (§4.2)', () => {
    const originalEnv = process.env.TYPESAFE_API_KEY;

    afterEach(() => {
      process.env.TYPESAFE_API_KEY = originalEnv;
      resetInvalidKeyLatch();
    });

    test('rebuilds client when environment key is dynamically rotated', () => {
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.JEV_API_KEY;
      const wrapper = new JevClientWrapper();
      expect(wrapper.isAvailable()).toBe(false);

      process.env.TYPESAFE_API_KEY = 'test_key_dynamic_1';
      expect(wrapper.isAvailable()).toBe(true);
      expect(wrapper.getClient()).not.toBeNull();

      process.env.TYPESAFE_API_KEY = 'test_key_dynamic_2';
      const client2 = wrapper.getClient();
      expect(client2).not.toBeNull();

      delete process.env.TYPESAFE_API_KEY;
      expect(wrapper.getClient()).toBeNull();
      expect(wrapper.isAvailable()).toBe(false);
    });

    test('reports availability accurately across Jev modes (off / local / remote)', () => {
      const wrapper = new JevClientWrapper();
      expect(wrapper.isAvailable('off')).toBe(false);

      const isDownloaded = jevModelManager.isModelDownloaded();
      expect(wrapper.isAvailable('local')).toBe(isDownloaded);
    });
    describe('12. Visual Target Extraction', () => {
      test('extracts a click target without treating input payloads as click goals', () => {
        expect(extractVisualTargetDescription('Click on "Submit Order" button')).toBe(
          'Submit Order',
        );
        expect(extractVisualTargetDescription('请点击“确认支付”图标')).toBe('确认支付');
        expect(extractVisualTargetDescription('Type shopping_cart into search')).toBe('');
        expect(extractVisualTargetDescription('click on the red cancel button')).toBe(
          'the red cancel button',
        );
        expect(extractVisualTargetDescription('点击登录头像')).toBe('登录头像');
      });

      test('rejects keyboard-key goals instead of turning them into visual click targets', () => {
        expect(extractVisualTargetDescription('Press Escape')).toBe('');
        expect(extractVisualTargetDescription('press the Escape key')).toBe('');
        expect(extractVisualTargetDescription('Tap on "Continue"')).toBe('Continue');
      });
    });

    describe('13. Screenshot Parsing & Frame Validation', () => {
      test('parses valid MCP screenshot response with image buffer and visionFrame', () => {
        const mockRes = {
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: Buffer.from('fake_image_bytes').toString('base64'),
            },
            {
              type: 'text',
              text: JSON.stringify({
                visionFrame: { id: 'frame_101', width: 1280, height: 720 },
              }),
            },
          ],
        };
        const parsed = parseScreenshotContent(mockRes);
        expect(parsed).not.toBeNull();
        expect(parsed!.imageBuffer.toString()).toBe('fake_image_bytes');
        expect(parsed!.frame).toEqual({ id: 'frame_101', width: 1280, height: 720 });
      });

      test('returns null if image or visionFrame is missing or invalid', () => {
        expect(parseScreenshotContent(null)).toBeNull();
        expect(parseScreenshotContent({ content: [] })).toBeNull();
        expect(
          parseScreenshotContent({
            content: [{ type: 'image', data: 'abc' }],
          }),
        ).toBeNull();
        expect(
          parseScreenshotContent({
            content: [
              { type: 'image', data: 'abc' },
              { type: 'text', text: 'invalid_json' },
            ],
          }),
        ).toBeNull();
        expect(
          parseScreenshotContent({
            content: [
              { type: 'image', data: 'abc' },
              {
                type: 'text',
                text: JSON.stringify({ visionFrame: { id: '', width: 0, height: 100 } }),
              },
            ],
          }),
        ).toBeNull();
      });
    });

    describe('14. Box Coordinate Validation', () => {
      test('validates correct normalized bounding box', () => {
        expect(validateBoxCoordinates({ top: 0.1, bottom: 0.5, left: 0.2, right: 0.8 })).toBe(true);
        expect(validateBoxCoordinates({ top: 0.0, bottom: 1.0, left: 0.0, right: 1.0 })).toBe(true);
      });

      test('rejects inverted or out of bounds coordinates', () => {
        expect(validateBoxCoordinates(null)).toBe(false);
        expect(validateBoxCoordinates({ top: 0.5, bottom: 0.2, left: 0.1, right: 0.9 })).toBe(
          false,
        ); // top >= bottom
        expect(validateBoxCoordinates({ top: 0.1, bottom: 0.5, left: 0.8, right: 0.2 })).toBe(
          false,
        ); // left >= right
        expect(validateBoxCoordinates({ top: -0.1, bottom: 0.5, left: 0.2, right: 0.8 })).toBe(
          false,
        ); // top < 0
        expect(validateBoxCoordinates({ top: 0.1, bottom: 1.2, left: 0.2, right: 0.8 })).toBe(
          false,
        ); // bottom > 1
        expect(validateBoxCoordinates({ top: 0.1, bottom: 0.5, left: NaN, right: 0.8 })).toBe(
          false,
        ); // NaN
      });
    });

    describe('15. JevClientWrapper queryVision Guard & Pipeline', () => {
      const fakeBuf = Buffer.from('fake_image_bytes');

      test('reads box support from the version upstream reports, not from the configured id', () => {
        // Jev 1.14 is the first release that can answer `box`.
        expect(supportsBoxQuestions('jev-1.14.0')).toBe(true);
        expect(supportsBoxQuestions('jev-1.14')).toBe(true);
        expect(supportsBoxQuestions('jev-preview')).toBe(false); // alias: no version to judge
        expect(supportsBoxQuestions('jev-1.13.0')).toBe(false);
        expect(supportsBoxQuestions('jev-2.0.0')).toBe(true); // a future major follows along
        expect(supportsBoxQuestions('my-vision-gateway')).toBe(false);
        expect(supportsBoxQuestions('')).toBe(false);
        expect(supportsBoxQuestions(undefined)).toBe(false);
      });

      test('the real SDK stops an in-flight visual request when its signal aborts', async () => {
        jevModelManager.setActiveMode('remote');
        jevModelManager.setRemoteConfig({ apiKey: 'dummy_key' });
        let requestStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          requestStarted = resolve;
        });
        const fetchMock = jest.fn(async (_url: any, init: any) => {
          requestStarted();
          return new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        });
        const sdk = new TypeSafeClient({
          apiKey: 'dummy_key',
          fetch: fetchMock,
          compression: false,
        });
        const client = new JevClientWrapper('dummy_key');
        jest.spyOn(client, 'getRemoteClient').mockReturnValue(sdk);
        (client as any).resolvedModelId = 'jev-1.14.0';
        const controller = new AbortController();
        const pending = client.queryVision(fakeBuf, 'bell icon', 'remote', {
          signal: controller.signal,
          timeout: 1000,
        });
        await started;
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
        const result = await pending;
        expect(result.result).toBeNull();
        expect(result.rawError?.name).toBe('APIUserAbortError');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      test('a real SDK visual rate limit returns without an implicit retry', async () => {
        jevModelManager.setActiveMode('remote');
        jevModelManager.setRemoteConfig({ apiKey: 'dummy_key' });
        const fetchMock = jest.fn(
          async () =>
            new Response('{"error":"rate limited"}', {
              status: 429,
              headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
            }),
        );
        const sdk = new TypeSafeClient({
          apiKey: 'dummy_key',
          fetch: fetchMock,
          compression: false,
        });
        const client = new JevClientWrapper('dummy_key');
        jest.spyOn(client, 'getRemoteClient').mockReturnValue(sdk);
        (client as any).resolvedModelId = 'jev-1.14.0';
        const result = await client.queryVision(fakeBuf, 'bell icon', 'remote', { timeout: 1000 });
        expect(result.errorReason).toBe('quota_exhausted');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      test.each([NaN, Infinity, -1, 1.1, null, '0.99'])(
        'malformed probability %s cannot authorize a visual click',
        async (noulValue) => {
          jevModelManager.setRemoteConfig({ apiKey: 'dummy_key' });
          const client = new JevClientWrapper('dummy_key');
          (client as any).resolvedModelId = 'jev-1.14.0';
          jest.spyOn(client, 'getRemoteClient').mockReturnValue({
            systemOne: async () => ({
              answers: {
                target_exists: { type: 'noul', noul: noulValue },
                target_ambiguous: { type: 'noul', noul: noulValue },
                destructive: { type: 'noul', noul: noulValue },
                target_box: {
                  type: 'box',
                  confidence: noulValue,
                  box: { left: 0.1, right: 0.2, top: 0.1, bottom: 0.2 },
                },
              },
            }),
          } as any);
          const res = await client.queryVision(fakeBuf, 'bell icon', 'remote');
          expect(res.result).toMatchObject({
            exists: false,
            ambiguous: true,
            destructive: true,
            confidence: null,
          });
        },
      );

      test('strictly rejects in off or local mode without calling SDK', async () => {
        const client = new JevClientWrapper('dummy_key');
        const offRes = await client.queryVision(fakeBuf, 'cart icon', 'off');
        expect(offRes.errorReason).toBe('jev_disabled');
        expect(offRes.result).toBeNull();

        const localRes = await client.queryVision(fakeBuf, 'cart icon', 'local');
        expect(localRes.errorReason).toBe('jev_disabled');
        expect(localRes.result).toBeNull();
      });

      test('fails closed without sending an image when upstream serves a pre-1.14 release', async () => {
        jevModelManager.setRemoteConfig({ apiKey: 'dummy_key' });
        const client = new JevClientWrapper('dummy_key');
        const systemOne = jest.fn(async () => ({
          model: 'jev-1.13.0',
          answers: { ready: { type: 'noul', noul: 1 } },
        }));
        jest.spyOn(client, 'getRemoteClient').mockReturnValue({ systemOne } as any);

        const res = await client.queryVision(fakeBuf, 'cart icon', 'remote');

        expect(res.errorReason).toBe('vision_model_unsupported');
        expect(res.result).toBeNull();
        // Only the text-only capability probe ran; the image never left the process.
        expect(systemOne).toHaveBeenCalledTimes(1);
        expect((systemOne.mock.calls[0] as any)[0].state).not.toHaveProperty('screenshot');
      });

      test('invokes remote client with the upstream-reported model, danger-zone header, and evaluates defensive questions', async () => {
        jevModelManager.setRemoteConfig({ apiKey: 'dummy_key' });
        const client = new JevClientWrapper('dummy_key');

        let capturedRequest: any = null;
        let capturedOptions: any = null;
        let call = 0;

        (client as any).client = {
          systemOne: async (req: any, opts: any) => {
            // First call is the text-only capability probe, second is the real vision query.
            if (call++ === 0) {
              return { model: 'jev-1.14.0', answers: { ready: { type: 'noul', noul: 1 } } };
            }
            capturedRequest = req;
            capturedOptions = opts;
            return {
              model: 'jev-1.14.0',
              answers: {
                target_exists: { type: 'noul', noul: 0.92 },
                target_ambiguous: { type: 'noul', noul: 0.15 },
                target_box: {
                  type: 'box',
                  box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 },
                  confidence: 0.88,
                },
                destructive: { type: 'noul', noul: 0.05 },
              },
              usage: { input_tokens: 300, output_tokens: 20 },
            };
          },
        };

        const res = await client.queryVision(fakeBuf, 'blue search button', 'remote');
        expect(res.errorReason).toBeNull();
        expect(res.result).not.toBeNull();
        expect(res.result!.exists).toBe(true);
        expect(res.result!.ambiguous).toBe(false);
        expect(res.result!.destructive).toBe(false);
        expect(res.result!.box).toEqual({ top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 });
        expect(res.result!.confidence).toBe(0.88);

        expect(capturedRequest.model).toBe('jev-1.14.0');
        expect(capturedOptions.headers[DANGER_ZONE_IMAGES_HEADER]).toBe('true');
        expect(capturedRequest.questions).toHaveProperty('target_exists');
        expect(capturedRequest.questions).toHaveProperty('target_ambiguous');
        expect(capturedRequest.questions).toHaveProperty('target_box');
        expect(capturedRequest.questions).toHaveProperty('destructive');
      });

      test('flags exists as false if target_exists noul < 0.85 (conservative threshold)', async () => {
        jevModelManager.setRemoteConfig({ apiKey: 'dummy_key' });
        const client = new JevClientWrapper('dummy_key');
        (client as any).resolvedModelId = 'jev-1.14.0';

        (client as any).client = {
          systemOne: async () => ({
            model: 'jev-1.14.0',
            answers: {
              target_exists: { type: 'noul', noul: 0.82 }, // below 0.85
              target_ambiguous: { type: 'noul', noul: 0.1 },
              target_box: {
                type: 'box',
                box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 },
                confidence: 0.5,
              },
              destructive: { type: 'noul', noul: 0.0 },
            },
          }),
        };

        const res = await client.queryVision(fakeBuf, 'missing icon', 'remote');
        expect(res.result!.exists).toBe(false);
      });
    });

    describe('16. Configuration identity guards across in-flight requests', () => {
      const fakeBuf = Buffer.from('fake_image_bytes');
      const state = { task: 'test', page: { url: '', title: '' }, elements: [], history: [] };

      /** Holds a request open so the endpoint can be reconfigured before the old one answers. */
      function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
      }

      function configureRemote(modelId: string): void {
        const getRemoteConfig = jevModelManager.getRemoteConfig as jest.Mock;
        getRemoteConfig.mockImplementation(() => ({
          ...realGetRemoteConfig(),
          apiKey: 'test_key',
          baseUrl: 'https://api.typesafe.ai',
          modelId,
        }));
      }

      beforeEach(() => {
        configureRemote('jev-latest');
      });

      test('a text query answered by a superseded endpoint does not cache its release', async () => {
        const client = new JevClientWrapper('test_key');
        const pending = deferred<any>();
        (client as any).client = { systemOne: () => pending.promise };

        const inFlight = client.query(state, {});
        configureRemote('gateway-model-b');
        pending.resolve({ model: 'jev-1.14.0', answers: {} });
        await inFlight;

        expect(client.getResolvedModelId()).toBeUndefined();
      });

      test('a capability probe answered by a superseded endpoint fails closed and caches nothing', async () => {
        const client = new JevClientWrapper('test_key');
        const pending = deferred<any>();
        (client as any).client = { systemOne: () => pending.promise };

        const inFlight = client.resolveBoxCapableModel();
        configureRemote('gateway-model-b');
        pending.resolve({ model: 'jev-1.14.0', answers: {} });

        await expect(inFlight).resolves.toBeNull();
        expect(client.getResolvedModelId()).toBeUndefined();
      });

      test('a superseded probe never hands back a release cached by the new configuration', async () => {
        const client = new JevClientWrapper('test_key');
        const pending = deferred<any>();
        (client as any).client = { systemOne: () => pending.promise };

        const inFlight = client.resolveBoxCapableModel();
        // The operator switches endpoints, `getClient()` refreshes, and a concurrent request
        // for the new endpoint caches its release while the old probe is still open.
        configureRemote('gateway-model-b');
        client.getRemoteClient();
        (client as any).resolvedModelId = 'jev-1.14.0';
        pending.resolve({ model: 'jev-1.13.0', answers: {} });

        await expect(inFlight).resolves.toBeNull();
      });

      test('a probe answered after the mode is revoked writes nothing to the cache', async () => {
        const client = new JevClientWrapper('test_key');
        const pending = deferred<any>();
        (client as any).client = { systemOne: () => pending.promise };

        const inFlight = client.resolveBoxCapableModel();
        (jevModelManager.getActiveMode as jest.Mock).mockReturnValue('local');
        pending.resolve({ model: 'jev-1.14.0', answers: {} });

        await expect(inFlight).resolves.toBeNull();
        expect(client.getResolvedModelId()).toBeUndefined();
      });

      test('a screenshot is never sent when the configuration changes while the probe is in flight', async () => {
        const client = new JevClientWrapper('test_key');
        const pendingProbe = deferred<any>();
        const oldSystemOne = jest.fn(() => pendingProbe.promise);
        (client as any).client = { systemOne: oldSystemOne };

        const inFlight = client.queryVision(fakeBuf, 'bell icon', 'remote');
        await Promise.resolve();
        configureRemote('gateway-model-b');
        pendingProbe.resolve({ model: 'jev-1.14.0', answers: {} });

        const res = await inFlight;
        expect(res.result).toBeNull();
        expect(res.errorReason).toBe('vision_model_unsupported');
        // The old endpoint only saw the text-only probe, never the screenshot.
        expect(oldSystemOne).toHaveBeenCalledTimes(1);
        expect((oldSystemOne.mock.calls[0] as any)[0].state).not.toHaveProperty('screenshot');
      });

      test('a screenshot is never sent to a client refreshed mid-probe', async () => {
        const client = new JevClientWrapper('test_key');
        const pendingProbe = deferred<any>();
        const oldSystemOne = jest.fn(() => pendingProbe.promise);
        (client as any).client = { systemOne: oldSystemOne };

        const inFlight = client.queryVision(fakeBuf, 'bell icon', 'remote');
        await Promise.resolve();
        configureRemote('gateway-model-b');
        // Force the `getClient()` refresh path while the probe is still open.
        const refreshed = client.getRemoteClient()!;
        const refreshedSystemOne = jest.fn(async () => ({ model: 'jev-1.14.0', answers: {} }));
        (refreshed as any).systemOne = refreshedSystemOne;
        pendingProbe.resolve({ model: 'jev-1.14.0', answers: {} });

        const res = await inFlight;
        expect(res.result).toBeNull();
        expect(refreshedSystemOne).not.toHaveBeenCalled();
        expect(oldSystemOne).toHaveBeenCalledTimes(1);
        expect((oldSystemOne.mock.calls[0] as any)[0].state).not.toHaveProperty('screenshot');
      });

      test('a late vision response after revocation does not refresh the release cache', async () => {
        const client = new JevClientWrapper('test_key');
        const pending = deferred<any>();
        (client as any).client = { systemOne: () => pending.promise };
        (client as any).resolvedModelId = 'jev-1.14.0';

        const inFlight = client.queryVision(fakeBuf, 'bell icon', 'remote');
        await Promise.resolve();
        (jevModelManager.getActiveMode as jest.Mock).mockReturnValue('off');
        pending.resolve({
          model: 'jev-1.15.0',
          answers: {
            target_exists: { type: 'noul', noul: 0.9 },
            target_ambiguous: { type: 'noul', noul: 0.1 },
            target_box: { type: 'box', box: { top: 0.1, bottom: 0.2, left: 0.1, right: 0.2 } },
            destructive: { type: 'noul', noul: 0.1 },
          },
        });

        await inFlight;
        expect(client.getResolvedModelId()).toBe('jev-1.14.0');
      });

      test('a late vision response from a replaced client cannot repopulate its release cache', async () => {
        const client = new JevClientWrapper('test_key');
        const pending = deferred<any>();
        const started = deferred<void>();
        (client as any).client = {
          systemOne: () => {
            started.resolve();
            return pending.promise;
          },
        };
        (client as any).resolvedModelId = 'jev-1.14.0';

        const inFlight = client.queryVision(fakeBuf, 'bell icon', 'remote');
        await started.promise;
        configureRemote('gateway-model-b');
        client.getRemoteClient();
        configureRemote('jev-latest');
        client.getRemoteClient();
        pending.resolve({ model: 'jev-1.15.0', answers: {} });
        await inFlight;

        expect(client.getResolvedModelId()).toBeUndefined();
      });

      test('the probe still caches when the configuration is unchanged, and is reused', async () => {
        const client = new JevClientWrapper('test_key');
        const systemOne = jest.fn(async () => ({ model: 'jev-1.14.0', answers: {} }));
        (client as any).client = { systemOne };

        await expect(client.resolveBoxCapableModel()).resolves.toBe('jev-1.14.0');
        await expect(client.resolveBoxCapableModel()).resolves.toBe('jev-1.14.0');
      });

      test('reports probe usage for the billed cold probe', async () => {
        const client = new JevClientWrapper('test_key');
        (client as any).client = {
          systemOne: jest.fn(async () => ({ model: 'jev-1.14.0', usage: { input_tokens: 42 } })),
        };
        const onProbeUsage = jest.fn((_usage: { inputTokens: number; latencyMs: number }) => {});

        await expect(
          client.resolveBoxCapableModel(undefined, undefined, onProbeUsage),
        ).resolves.toBe('jev-1.14.0');

        expect(onProbeUsage).toHaveBeenCalledTimes(1);
        expect(onProbeUsage.mock.calls[0][0].inputTokens).toBe(42);
        expect(onProbeUsage.mock.calls[0][0].latencyMs).toBeGreaterThanOrEqual(0);
      });

      test('does not report probe usage when the release is already cached', async () => {
        const client = new JevClientWrapper('test_key');
        (client as any).resolvedModelId = 'jev-1.14.0';
        const onProbeUsage = jest.fn();

        await expect(
          client.resolveBoxCapableModel(undefined, undefined, onProbeUsage),
        ).resolves.toBe('jev-1.14.0');
        expect(onProbeUsage).not.toHaveBeenCalled();
      });

      test('an unknown release still fails closed and is not retried forever within one call', async () => {
        const client = new JevClientWrapper('test_key');
        const systemOne = jest.fn(async () => ({ model: 'my-vision-gateway', answers: {} }));
        (client as any).client = { systemOne };

        await expect(client.resolveBoxCapableModel()).resolves.toBeNull();
        expect(client.getResolvedModelId()).toBe('my-vision-gateway');
      });

      test('local mode never probes or reports a box-capable remote model', async () => {
        const client = new JevClientWrapper('test_key');
        const systemOne = jest.fn(async () => ({ model: 'jev-1.14.0', answers: {} }));
        (client as any).client = { systemOne };
        const localSystemOne = jest.fn(async () => ({ model: 'jev-1.14.0', answers: {} }));
        jest.spyOn(client, 'getLocalClient').mockReturnValue({ systemOne: localSystemOne } as any);
        (jevModelManager.getActiveMode as jest.Mock).mockReturnValue('local');

        await expect(client.resolveBoxCapableModel()).resolves.toBeNull();
        expect(systemOne).not.toHaveBeenCalled();
        expect(localSystemOne).not.toHaveBeenCalled();
        expect(client.getResolvedModelId()).toBeUndefined();
      });

      test('off mode never probes or reports a box-capable remote model', async () => {
        const client = new JevClientWrapper('test_key');
        const systemOne = jest.fn(async () => ({ model: 'jev-1.14.0', answers: {} }));
        (client as any).client = { systemOne };
        (jevModelManager.getActiveMode as jest.Mock).mockReturnValue('off');

        await expect(client.resolveBoxCapableModel()).resolves.toBeNull();
        expect(systemOne).not.toHaveBeenCalled();
      });
    });
  });
});
