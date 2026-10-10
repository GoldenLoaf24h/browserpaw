import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Decider Startup Scripts Contract (JEV-P2-02)', () => {
  const shPath = resolve(process.cwd(), 'scripts/decider/start-local-service.sh');
  const batPath = resolve(process.cwd(), 'scripts/decider/start-local-service.bat');

  it('verifies start-local-service.sh launches uvicorn with decider.serve:app', () => {
    assert.strictEqual(existsSync(shPath), true, 'start-local-service.sh should exist');
    const content = readFileSync(shPath, 'utf8');
    assert.match(content, /uvicorn decider\.serve:app/, 'Should invoke uvicorn decider.serve:app');
    assert.match(content, /--port "\${PORT}"|--port 8009/, 'Should bind to PORT');
    assert.match(content, /export DECIDER_MODEL=/, 'Should export DECIDER_MODEL');
    assert.match(content, /PYTHONPATH.*DECIDER_REPO_DIR/, 'Should setup PYTHONPATH bootstrap');
    assert.doesNotMatch(content, /-m decider\.serve --model/, 'Should not use invalid cli flags');
  });

  it('verifies start-local-service.bat aligns bootstrap environment with native manager', () => {
    assert.strictEqual(existsSync(batPath), true, 'start-local-service.bat should exist');
    const content = readFileSync(batPath, 'utf8');
    assert.match(content, /uvicorn decider\.serve:app/, 'Should invoke uvicorn decider.serve:app');
    assert.match(content, /PYTHONPATH=%DECIDER_REPO_DIR%/, 'Should configure PYTHONPATH for decider-repo');
  });
});
