const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertNoLinks, ensureDirectory, atomicWrite, acquireLock } = require('./cli-files.cjs');

const extensions = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function decodeBase64(value) {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error('Invalid artifact base64 payload');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid artifact base64 payload');
  return bytes;
}

function prepareArtifactDirectory(directory) {
  const root = path.resolve(directory);
  ensureDirectory(root);
  const release = acquireLock(path.join(root, '.browserpaw-artifacts.lock'));
  try {
    const entries = fs.readdirSync(root).filter((entry) => entry !== '.browserpaw-artifacts.lock');
    if (entries.length)
      throw new Error(
        'Artifact output directory must be empty; choose a new directory for each call.',
      );
  } catch (error) {
    release();
    throw error;
  }
  return { root, release };
}

function writeRawArtifactResult(root, result) {
  assertNoLinks(root);
  const resultPath = path.join(root, 'result.json');
  atomicWrite(resultPath, JSON.stringify(result, null, 2) + '\n');
  return resultPath;
}

function writeArtifactManifest(root, manifest) {
  atomicWrite(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function writeArtifactResult(root, result, resultPath) {
  const artifactsDir = path.join(root, 'artifacts');
  ensureDirectory(artifactsDir);
  let index = 0;
  const save = (block, bytes, mimeType) => {
    const filename = `item-${String(++index).padStart(4, '0')}${extensions[mimeType] || '.bin'}`;
    const target = path.join(artifactsDir, filename);
    atomicWrite(target, bytes);
    return {
      type: 'artifact_ref',
      originalType: block.type,
      mimeType,
      path: target,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(block.type === 'resource' ? { uri: block.resource.uri } : {}),
    };
  };
  const references = [];
  const content = result.content?.map((block) => {
    if (block.type === 'image' || block.type === 'audio') {
      const reference = save(
        block,
        decodeBase64(block.data),
        block.mimeType || 'application/octet-stream',
      );
      references.push([block.data, reference]);
      return reference;
    }
    if (block.type === 'resource' && block.resource) {
      const resource = block.resource;
      if (typeof resource.blob === 'string') {
        const reference = save(
          block,
          decodeBase64(resource.blob),
          resource.mimeType || 'application/octet-stream',
        );
        references.push([resource.blob, reference]);
        return reference;
      }
      if (typeof resource.text === 'string' && Buffer.byteLength(resource.text) > 4096) {
        const reference = save(
          block,
          Buffer.from(resource.text),
          resource.mimeType || 'text/plain',
        );
        references.push([resource.text, reference]);
        return reference;
      }
    }
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      Buffer.byteLength(block.text) > 4096
    ) {
      const reference = save(block, Buffer.from(block.text), 'text/plain');
      references.push([block.text, reference]);
      return reference;
    }
    return block;
  });
  const replacePayloads = (value) => {
    if (typeof value === 'string') {
      let replaced = value;
      for (const [payload, reference] of references) {
        if (replaced === payload) return reference;
        if (payload && replaced.includes(payload))
          replaced = replaced.split(payload).join(`[artifact_ref ${reference.path}]`);
      }
      return replaced;
    }
    if (Array.isArray(value)) return value.map(replacePayloads);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replacePayloads(item)]),
      );
    return value;
  };
  const manifest = {
    ...result,
    ...(content ? { content } : {}),
    ...(result.structuredContent
      ? { structuredContent: replacePayloads(result.structuredContent) }
      : {}),
    resultPath,
  };
  writeArtifactManifest(root, manifest);
  return manifest;
}

module.exports = {
  prepareArtifactDirectory,
  writeRawArtifactResult,
  writeArtifactManifest,
  writeArtifactResult,
};
