// Test script for Local Jev Decision Engine
const body = {
  state: {
    task: 'Search for NVIDIA RTX 5090 graphics card',
    page: {
      url: 'https://www.bing.com',
      title: 'Bing'
    },
    elements: [
      '[1] searchbox "Search the web" #sb_form_q',
      '[2] button "Search" #search_icon',
      '[3] link "Images"',
      '[4] link "Videos"',
      '[5] link "Maps"'
    ],
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
    type_target: {
      type: 'choice',
      instructions: 'Which input or textarea element index [N] should receive text entry?',
      criteria: {
        '1': 'searchbox "Search the web" #sb_form_q',
        'none': 'No suitable matching element found on current viewport'
      }
    },
    click_target: {
      type: 'choice',
      instructions: 'Which element index [N] should be clicked to advance toward the task goal?',
      criteria: {
        '2': 'button "Search" #search_icon',
        '3': 'link "Images"',
        '4': 'link "Videos"',
        '5': 'link "Maps"',
        'none': 'No suitable matching element found on current viewport'
      }
    },
    goal_done: {
      type: 'noul',
      instructions: 'Has the overall task goal been completely and successfully achieved based on the current page state and history?'
    }
  }
};

async function main() {
  console.log('Sending System One request to local decider at http://127.0.0.1:8009/v1/systemone ...');
  const t0 = performance.now();
  const resp = await fetch('http://127.0.0.1:8009/v1/systemone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const latency = (performance.now() - t0).toFixed(1);
  const data = await resp.json();
  console.log(`\n[Status: ${resp.status}] Response time: ${latency} ms`);
  console.log('Answers:');
  for (const [k, v] of Object.entries(data.answers || {})) {
    console.log(`- ${k}:`, JSON.stringify(v));
  }
}

main().catch(console.error);
