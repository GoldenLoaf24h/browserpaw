import { JevClientWrapper, resetInvalidKeyLatch, isSessionKeyInvalid } from './jev-client';
import { jevModelManager } from '../server/jev-model-manager';

describe('model failures and cancellation', () => {
  const state = { task: 'locate email', page: { url: '', title: '' }, elements: [], history: [] };
  beforeEach(() => {
    resetInvalidKeyLatch();
    jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote');
    jest.spyOn(jevModelManager, 'disableIfCurrent').mockReturnValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  function clientWith(systemOne: () => Promise<any>) {
    const client = new JevClientWrapper('test-not-a-real-key');
    jest.spyOn(client, 'getRemoteClient').mockReturnValue({ systemOne } as any);
    return client;
  }

  test('a transport failure disables only the captured configuration', async () => {
    const token = jevModelManager.captureModeToken();
    const client = clientWith(async () => {
      throw new Error('offline');
    });
    expect((await client.query(state, {})).result).toBeNull();
    expect(jevModelManager.disableIfCurrent).toHaveBeenCalledWith(token, 'network_error');
  });

  test('manual cancellation does not disable the model', async () => {
    const controller = new AbortController();
    const client = clientWith(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await client.query(state, {}, undefined, { signal: controller.signal });
    expect(jevModelManager.disableIfCurrent).not.toHaveBeenCalled();
  });

  test('visual transport failures use the same automatic off contract', async () => {
    const client = clientWith(async () => {
      throw Object.assign(new Error('offline'), { status: 429 });
    });
    jest.spyOn(client, 'resolveBoxCapableModel').mockResolvedValue('jev-1.14.0');
    await client.queryVision(Buffer.from('image fixture'), 'bell icon');
    expect(jevModelManager.disableIfCurrent).toHaveBeenCalledWith(
      jevModelManager.captureModeToken(),
      'quota_exhausted',
    );
  });

  test('a visual cancellation does not disable the model or latch a credential error', async () => {
    const controller = new AbortController();
    const client = clientWith(async () => {
      controller.abort();
      throw Object.assign(new Error('cancelled'), { status: 401 });
    });
    jest.spyOn(client, 'resolveBoxCapableModel').mockResolvedValue('jev-1.14.0');
    await client.queryVision(Buffer.from('image fixture'), 'bell icon', undefined, {
      signal: controller.signal,
    });
    expect(jevModelManager.disableIfCurrent).not.toHaveBeenCalled();
    expect(isSessionKeyInvalid()).toBe(false);
  });

  test('an old unauthorized response cannot latch the replacement credential', async () => {
    let revision = 1;
    jest
      .spyOn(jevModelManager, 'captureModeToken')
      .mockImplementation(() => ({ revision, activeMode: 'remote' }));
    let reject!: (error: unknown) => void;
    const old = new Promise<never>((_resolve, rejectRequest) => {
      reject = rejectRequest;
    });
    const client = clientWith(() => old);
    const pending = client.query(state, {});
    revision = 2;
    reject(Object.assign(new Error('old credential rejected'), { status: 401 }));
    await pending;
    expect(isSessionKeyInvalid()).toBe(false);
    expect(jevModelManager.disableIfCurrent).toHaveBeenCalledWith(
      { revision: 1, activeMode: 'remote' },
      'invalid_key',
    );
  });

  test('a malformed judgment disables the model; a genuine none does not', async () => {
    const questions = {
      target: { type: 'choice', criteria: { email: 'Email', none: 'No target' } },
    };
    const client = clientWith(async () => ({
      answers: {
        target: { type: 'choice', choice: 'email', confidence: 1, probabilities: { invented: 1 } },
      },
    }));
    expect((await client.query(state, questions)).result).toBeNull();
    expect(jevModelManager.disableIfCurrent).toHaveBeenCalledTimes(1);
    jest.mocked(jevModelManager.disableIfCurrent).mockClear();
    const none = clientWith(async () => ({
      answers: {
        target: {
          type: 'choice',
          choice: 'none',
          confidence: 1,
          probabilities: { email: 0, none: 1 },
        },
      },
    }));
    expect((await none.query(state, questions)).result).not.toBeNull();
    expect(jevModelManager.disableIfCurrent).not.toHaveBeenCalled();
  });
});
