// benchmark-real-sites.mjs
// Real-world practical test of Local Jev Decision Engine (decider-2b)
import fs from 'node:fs';

const BRIDGE_URL = 'http://127.0.0.1:12306';
const DECIDER_URL = 'http://127.0.0.1:8009/v1/systemone';
const TOKEN = '560bde5b61794a588e93cd6d086d0b5a26a5b9ccef205cd293b78b1cc5ccdff8';

async function callTool(name, args = {}) {
  const resp = await fetch(`${BRIDGE_URL}/call-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'x-local-trust': 'true'
    },
    body: JSON.stringify({ name, args })
  });
  const data = await resp.json();
  if (data?.data?.data?.content?.[0]?.text) {
    try {
      return JSON.parse(data.data.data.content[0].text);
    } catch {
      return data.data.data.content[0].text;
    }
  }
  return data;
}

async function askLocalDecider(goal, tabUrl, tabTitle, elements) {
  // Extract up to 35 compact elements with indices
  const candidateIndices = [];
  const targetCriteria = {};
  
  for (const line of elements) {
    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (match) {
      const idx = match[1];
      candidateIndices.push(idx);
      targetCriteria[idx] = match[2].slice(0, 70).trim();
      if (candidateIndices.length >= 35) break;
    }
  }
  targetCriteria['none'] = 'No suitable matching element found on current viewport';

  const body = {
    state: {
      task: goal,
      page: { url: (tabUrl || '').slice(0, 150), title: (tabTitle || '').slice(0, 100) },
      elements: elements.slice(0, 35),
      history: []
    },
    questions: {
      action: {
        type: 'choice',
        instructions: 'What is the next single browser action to advance toward the task goal?',
        criteria: {
          click: 'Click a button, link, checkbox, radio, tab, or interactive element',
          type: 'Enter or fill text into an input field or textarea',
          select: 'Select an option from a dropdown or select menu',
          scroll_down: 'Scroll down the page to reveal more content below',
          scroll_up: 'Scroll up the page to reveal content above',
          back: 'Navigate back to the previous page',
          wait: 'Wait for page content to load or changes to settle',
          done: 'The goal has been fully accomplished on the current page',
          escalate: 'Cannot proceed, ambiguous options, destructive action needed, or requires user intervention'
        }
      },
      click_target: {
        type: 'choice',
        instructions: 'Which element index [N] should be clicked to advance toward the task goal?',
        criteria: targetCriteria
      },
      type_target: {
        type: 'choice',
        instructions: 'Which input or textarea element index [N] should receive text entry?',
        criteria: targetCriteria
      },
      goal_done: {
        type: 'noul',
        instructions: 'Has the overall task goal been completely and successfully achieved based on the current page state and history?'
      }
    }
  };

  const t0 = performance.now();
  const resp = await fetch(DECIDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const latencyMs = Math.round(performance.now() - t0);
  const result = await resp.json();

  return {
    status: resp.status,
    latencyMs,
    answers: result.answers || {}
  };
}

async function runBenchmark() {
  console.log('================================================================');
  console.log('   BrowserPaw Local Jev Decision Engine Real-World Benchmark    ');
  console.log('             Model: decider-2b (Port: 8009)                     ');
  console.log('================================================================\n');

  const testCases = [
    {
      name: 'Test 1: Code Repository (GitHub BrowserClaw)',
      navigateUrl: 'https://github.com/GoldenLoaf24h/browserclaw',
      goal: 'Find and click the "Issues" or "Pull requests" navigation tab to view project tickets',
      expectedAction: 'click'
    },
    {
      name: 'Test 2: Search Engine Query Entry (Bing Search)',
      navigateUrl: 'https://www.bing.com',
      goal: 'Type "DeepSeek V3" into the search box to perform a web search',
      expectedAction: 'type'
    },
    {
      name: 'Test 3: Knowledge Portal (Wikipedia Main Page)',
      navigateUrl: 'https://en.wikipedia.org/wiki/Main_Page',
      goal: 'Find the search input box to search for "Artificial Intelligence"',
      expectedAction: 'type'
    },
    {
      name: 'Test 4: Content Feed (Hacker News)',
      navigateUrl: 'https://news.ycombinator.com',
      goal: 'Click on the "new" link in the top navigation bar to read newest submissions',
      expectedAction: 'click'
    }
  ];

  const results = [];

  // 1. Create or identify a test tab
  console.log('[Setup] Opening test tab in browser...');
  const navResult = await callTool('chrome_navigate', { url: testCases[0].navigateUrl });
  const testTabId = navResult?.tabId;
  console.log(`[Setup] Using tabId: ${testTabId}\n`);

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`----------------------------------------------------------------`);
    console.log(`[${i + 1}/${testCases.length}] Running: ${tc.name}`);
    console.log(`URL: ${tc.navigateUrl}`);
    console.log(`Goal: "${tc.goal}"`);

    // Navigate if not already on the page
    if (i > 0) {
      console.log(`Navigating to ${tc.navigateUrl}...`);
      await callTool('chrome_navigate', { url: tc.navigateUrl, tabId: testTabId });
      // Wait for page to settle
      await new Promise(r => setTimeout(r, 2000));
    } else {
      await new Promise(r => setTimeout(r, 1500));
    }

    // Read DOM
    console.log(`Perceiving active viewport DOM...`);
    const domData = await callTool('chrome_read_dom', {
      tabId: testTabId,
      activeViewportOnly: true,
      limit: 100
    });

    const treeLines = (domData?.treeString || '').split('\n').map(l => l.trim()).filter(Boolean);
    console.log(`DOM read complete: ${treeLines.length} elements extracted. Title: "${domData?.tabTitle || ''}"`);

    // Query Local Jev
    console.log(`Sending semantic decision query to local decider-2b...`);
    const decision = await askLocalDecider(tc.goal, domData?.tabUrl, domData?.tabTitle, treeLines);

    const actionAns = decision.answers.action;
    const clickAns = decision.answers.click_target;
    const typeAns = decision.answers.type_target;
    const goalDone = decision.answers.goal_done;

    const chosenAction = actionAns?.choice || 'unknown';
    const actionConf = actionAns?.confidence ?? 0;
    const targetChosen = chosenAction === 'type' ? typeAns?.choice : clickAns?.choice;
    const targetConf = chosenAction === 'type' ? typeAns?.confidence : clickAns?.confidence;

    // Resolve target line
    const targetLine = treeLines.find(l => l.startsWith(`[${targetChosen}]`)) || `[${targetChosen}]`;

    console.log(`[Result] Latency: ${decision.latencyMs} ms`);
    console.log(`[Result] Action: "${chosenAction}" (confidence: ${(actionConf * 100).toFixed(1)}%)`);
    console.log(`[Result] Target: ${targetLine} (confidence: ${((targetConf || 0) * 100).toFixed(1)}%)`);
    console.log(`[Result] Goal Done: ${((goalDone?.noul || 0) * 100).toFixed(1)}%`);

    const isActionMatch = chosenAction === tc.expectedAction;
    console.log(`[Evaluation] Action Match Expected (${tc.expectedAction}): ${isActionMatch ? 'PASS ✅' : 'FAIL ❌'}`);

    results.push({
      caseName: tc.name,
      url: tc.navigateUrl,
      goal: tc.goal,
      latencyMs: decision.latencyMs,
      chosenAction,
      expectedAction: tc.expectedAction,
      actionConfidence: actionConf,
      targetElement: targetLine,
      targetConfidence: targetConf,
      goalDoneProb: goalDone?.noul,
      isActionMatch
    });
    console.log('');
  }

  // Summary Report
  console.log('================================================================');
  console.log('                     BENCHMARK SUMMARY REPORT                   ');
  console.log('================================================================');
  console.table(results.map(r => ({
    Scenario: r.caseName.split(':')[0],
    Action: `${r.chosenAction} (${(r.actionConfidence * 100).toFixed(0)}%)`,
    Target: r.targetElement.slice(0, 35),
    Latency: `${(r.latencyMs / 1000).toFixed(1)}s`,
    Status: r.isActionMatch ? 'PASS' : 'FAIL'
  })));

  fs.writeFileSync('benchmark-results.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to benchmark-results.json');
}

runBenchmark().catch(console.error);
