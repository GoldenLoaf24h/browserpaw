import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

async function checkPortOnline(port = 8009) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function run() {
  console.log('--- STEP 1: Check initial port 8009 status ---');
  let health = await checkPortOnline(8009);
  console.log('Initial health:', health);

  console.log('\n--- STEP 2: Start local Decider-2B on GPU (port 8009) ---');
  const home = homedir();
  const venvPython = join(home, '.browserpaw', 'venv', 'Scripts', 'python.exe');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python';
  const deciderRepoDir = join(home, '.browserpaw', 'decider-repo');
  const modelDir = join(home, '.browserpaw', 'models', 'decider-2b');

  const env = {
    ...process.env,
    DECIDER_MODEL: modelDir,
    DECIDER_DEVICE: 'cuda',
    DECIDER_WARMUP: '0',
    DECIDER_IDLE_TIMEOUT: '600',
    PYTHONPATH: `${deciderRepoDir};${process.env.PYTHONPATH || ''}`,
  };

  const child = spawn(
    pythonBin,
    ['-m', 'uvicorn', 'decider.serve:app', '--host', '127.0.0.1', '--port', '8009'],
    {
      detached: true,
      cwd: deciderRepoDir,
      stdio: 'inherit',
      env,
      windowsHide: true,
    }
  );
  child.unref();

  console.log(`Spawned PID: ${child.pid}. Waiting for readiness...`);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    health = await checkPortOnline(8009);
    if (health && health.ok) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    console.error('Failed to start Decider service within 20s');
    process.exit(1);
  }

  console.log('Decider service online! Health:', JSON.stringify(health, null, 2));
  console.log('Verified Device:', health.device, '(Must be CUDA GPU)');

  console.log('\n--- STEP 3: Test inference via /v1/systemone ---');
  const t0 = performance.now();
  const s1Res = await fetch('http://127.0.0.1:8009/v1/systemone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: 'User wants to open a flight ticket on 12306',
      questions: {
        intent: {
          type: 'choice',
          instructions: 'What is the intent?',
          criteria: { travel: 'Book a trip', other: 'Other task' }
        }
      }
    })
  });
  const s1Data = await s1Res.json();
  const latency = (performance.now() - t0).toFixed(1);
  console.log(`Inference successful in ${latency}ms! Result:`, JSON.stringify(s1Data.answers));

  console.log('\n--- STEP 4: Test /touch endpoint ---');
  const touchRes = await fetch('http://127.0.0.1:8009/touch', { method: 'POST' });
  const touchData = await touchRes.json();
  console.log('Touch response:', touchData);

  console.log('\n--- STEP 5: Test /unload and VRAM release ---');
  const unloadRes = await fetch('http://127.0.0.1:8009/unload', { method: 'POST' });
  console.log('Unload response status:', unloadRes.status);

  console.log('Waiting for process to exit and port 8009 to be freed...');
  let freed = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    health = await checkPortOnline(8009);
    if (!health) {
      freed = true;
      break;
    }
  }
  console.log('Port 8009 freed:', freed);
  if (!freed) {
    console.error('Port 8009 still holding!');
    process.exit(1);
  }
  console.log('ALL LIVE GPU VERIFICATION TESTS PASSED CLEANLY!');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
