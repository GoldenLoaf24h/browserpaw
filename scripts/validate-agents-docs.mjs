import fs from 'node:fs';
import path from 'node:path';

function findAgentsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', '.output', '__pycache__', '.wxt'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAgentsFiles(fullPath));
    } else if (entry.name === 'AGENTS.md') {
      results.push(fullPath);
    }
  }
  return results;
}

const agentsFiles = findAgentsFiles('.');
console.log(`Found ${agentsFiles.length} AGENTS.md files to validate.`);

let errors = 0;

for (const filePath of agentsFiles) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const dir = path.dirname(filePath);
  const isRoot = dir === '.';

  // Check 1: Root should not have Parent context, all others MUST have Parent context
  if (isRoot) {
    if (content.includes('**Parent context:**')) {
      console.error(`ERROR: Root AGENTS.md should not have Parent context`);
      errors++;
    }
  } else {
    const match = content.match(/\*\*Parent context:\*\*\s*`([^`]+)`/);
    if (!match) {
      console.error(`ERROR: Missing parent context in ${filePath}`);
      errors++;
    } else {
      const parentRel = match[1];
      const resolvedParent = path.resolve(dir, parentRel);
      if (!fs.existsSync(resolvedParent)) {
        console.error(`ERROR: Broken parent reference in ${filePath} -> ${parentRel} (resolved to ${resolvedParent})`);
        errors++;
      }
    }
  }

  // Check 2: Timestamps
  if (!content.includes('**Generated:**') || !content.includes('**Updated:**')) {
    console.error(`ERROR: Missing timestamps in ${filePath}`);
    errors++;
  }

  // Check 3: Required sections
  const requiredSections = [
    '## Purpose',
    '## Key Files',
    '## Subdirectories',
    '## For AI Agents',
    '## Dependencies',
    '## Manual Notes'
  ];

  for (const sec of requiredSections) {
    if (!content.includes(sec)) {
      console.error(`ERROR: Missing section "${sec}" in ${filePath}`);
      errors++;
    }
  }
}

if (errors === 0) {
  console.log(`All ${agentsFiles.length} AGENTS.md files PASSED validation successfully!`);
} else {
  console.error(`Validation failed with ${errors} errors.`);
  process.exit(1);
}
