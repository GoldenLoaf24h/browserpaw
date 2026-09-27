import { describe, expect, test, beforeEach } from '@jest/globals';
import {
  isSensitiveElement,
  buildState,
  extractElementIndices,
  buildQuestions,
  validateChoice,
  extractTextPayload,
  isDestructiveTarget,
  getTop3Probabilities,
  isSessionKeyInvalid,
  latchInvalidKey,
  resetInvalidKeyLatch,
  DESTRUCTIVE_KEYWORDS,
  JevClientWrapper,
} from './jev-client';
import { jevModelManager } from '../server/jev-model-manager';

describe('Jev Client & Helper Unit Tests', () => {
  beforeEach(() => {
    resetInvalidKeyLatch();
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
  });

  describe('3. Questions assembly (§5.2)', () => {
    test('builds 7 parallel questions with proper criteria', () => {
      const elements = ['[1] button "Submit"', '[12] textbox "Search"', '[25] link "Help"'];
      const questions = buildQuestions(elements, 'Search BrowserPaw');

      expect(questions).toHaveProperty('action');
      expect(questions).toHaveProperty('click_target');
      expect(questions).toHaveProperty('type_target');
      expect(questions).toHaveProperty('select_target');
      expect(questions).toHaveProperty('goal_done');
      expect(questions).toHaveProperty('stuck');
      expect(questions).toHaveProperty('destructive');

      expect(questions.action.type).toBe('choice');
      expect(questions.click_target.type).toBe('choice');
      expect(questions.goal_done.type).toBe('noul');
      expect(questions.stuck.type).toBe('noul');
      expect(questions.destructive.type).toBe('noul');

      const clickCriteriaKeys = Object.keys(questions.click_target.criteria);
      expect(clickCriteriaKeys).toContain('1');
      expect(clickCriteriaKeys).toContain('12');
      expect(clickCriteriaKeys).toContain('25');
      expect(clickCriteriaKeys).toContain('none');
    });

    test('deduplicates element indices when elements list contains duplicate indices', () => {
      const elements = ['[5] button "OK"', '[5] button "OK Duplicate"', '[8] link "Home"'];
      const indices = extractElementIndices(elements);
      expect(indices).toEqual(['5', '8']);

      const questions = buildQuestions(elements, 'Click OK');
      const clickKeys = Object.keys(questions.click_target.criteria);
      expect(clickKeys).toEqual(['5', '8', 'none']);
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
    test('detects all 14 built-in destructive keywords', () => {
      expect(DESTRUCTIVE_KEYWORDS).toHaveLength(14);
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
    test('shortlists >10 options by relevance and returns token usage', async () => {
      const client = new JevClientWrapper('dummy_key');
      const manyOptions = Array.from({ length: 25 }, (_, i) => ({
        text: `State ${i}`,
        value: `ST_${i}`,
      }));
      manyOptions.push({ text: 'California', value: 'CA' });

      (client as any).client = {
        systemOne: async (req: any) => {
          return {
            model: 'jev-latest',
            answers: {
              select_option: {
                type: 'score',
                score: 0,
                confidence: 0.95,
                probabilities: { '0': 0.95, '1': 0.05 },
              },
            },
            usage: { input_tokens: 420, output_tokens: 15 },
          };
        },
      };

      const result = await client.scoreOptions('Ship to California', manyOptions);
      expect(result).not.toBeNull();
      expect(result!.bestOption.text).toBe('California');
      expect(result!.confidence).toBe(0.95);
      expect(result!.usage?.inputTokens).toBe(420);
    });

    test('returns index 0 immediately for single option without calling Jev', async () => {
      const client = new JevClientWrapper('dummy_key');
      const single = [{ text: 'Only Option', value: 'only' }];
      const result = await client.scoreOptions('Select', single);
      expect(result).toEqual({
        bestIndex: 0,
        bestOption: single[0],
        confidence: 1.0,
        score: 0,
        usage: { inputTokens: 0 },
      });
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
  });
});
