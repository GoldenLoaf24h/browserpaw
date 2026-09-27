// run-mcp-act.mjs
const BRIDGE_URL = 'http://127.0.0.1:12306';
const TOKEN = '560bde5b61794a588e93cd6d086d0b5a26a5b9ccef205cd293b78b1cc5ccdff8';

async function callMcpTool(name, args = {}) {
  const t0 = performance.now();
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
  const elapsed = Math.round(performance.now() - t0);
  return { elapsed, data };
}

async function main() {
  const tabId = parseInt(process.argv[2] || '1581274497', 10);
  const goal = process.argv[3] || 'Type "DeepSeek" into the search box and search';
  const maxSteps = parseInt(process.argv[4] || '2', 10);

  console.log(`[MCP Tool: chrome_act_toward_goal]`);
  console.log(`Tab ID: ${tabId}`);
  console.log(`Goal: "${goal}"`);
  console.log(`Max Steps: ${maxSteps}`);
  console.log(`Calling MCP tool...`);

  const { elapsed, data } = await callMcpTool('chrome_act_toward_goal', {
    goal,
    tabId,
    maxSteps
  });

  console.log(`\nCompleted in ${elapsed} ms`);
  const contentText = data?.data?.content?.[0]?.text;
  if (contentText) {
    try {
      const parsed = JSON.parse(contentText);
      console.log('Result payload:\n', JSON.stringify(parsed, null, 2));
    } catch {
      console.log('Result text:\n', contentText);
    }
  } else {
    console.log('Full response:\n', JSON.stringify(data, null, 2));
  }
}

main().catch(console.error);
