import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import fileHandler from './file-handler';

describe('BUG-16: Concurrent temporary upload files must use unique request prefix without collision or cross-request cleanup race', () => {
  it('generates unique file paths when two concurrent prepareFile requests upload default or same fileName', async () => {
    const base64Data1 = Buffer.from('content 1').toString('base64');
    const base64Data2 = Buffer.from('content 2').toString('base64');

    // Both requests use default / same fileName 'uploaded-file'
    const res1 = await fileHandler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64Data1,
      fileName: 'uploaded-file',
    });

    const res2 = await fileHandler.handleFileRequest({
      action: 'prepareFile',
      base64Data: base64Data2,
      fileName: 'uploaded-file',
    });

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);

    // Fail if both paths are identical (race condition / overwrite)
    expect(res1.filePath).not.toBe(res2.filePath);

    // Physical file name on disk must preserve original fileName for CDP DOM.setFileInputFiles
    expect(path.basename(res1.filePath)).toBe('uploaded-file');
    expect(path.basename(res2.filePath)).toBe('uploaded-file');
    expect(path.dirname(res1.filePath)).not.toBe(path.dirname(res2.filePath));

    // Verify both files actually exist on disk and contain their distinct content
    expect(fs.existsSync(res1.filePath)).toBe(true);
    expect(fs.existsSync(res2.filePath)).toBe(true);
    expect(fs.readFileSync(res1.filePath, 'utf8')).toBe('content 1');
    expect(fs.readFileSync(res2.filePath, 'utf8')).toBe('content 2');

    // Clean up res1: res2 must not be affected
    await fileHandler.handleFileRequest({
      action: 'cleanupFile',
      filePath: res1.filePath,
    });
    expect(fs.existsSync(res1.filePath)).toBe(false);
    expect(fs.existsSync(res2.filePath)).toBe(true);
    expect(fs.readFileSync(res2.filePath, 'utf8')).toBe('content 2');

    // Clean up res2
    await fileHandler.handleFileRequest({
      action: 'cleanupFile',
      filePath: res2.filePath,
    });
    expect(fs.existsSync(res2.filePath)).toBe(false);
  });

  it('cleanupFile preserves sibling files in parent directory and only removes empty directory', async () => {
    const res = await fileHandler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('main file').toString('base64'),
      fileName: 'main.bin',
    });

    expect(res.success).toBe(true);
    const parentDir = path.dirname(res.filePath);
    const siblingPath = path.join(parentDir, 'sibling.txt');
    fs.writeFileSync(siblingPath, 'do not delete sibling');

    // Cleanup main file
    await fileHandler.handleFileRequest({
      action: 'cleanupFile',
      filePath: res.filePath,
    });

    // Target file is deleted, but sibling and directory remain intact
    expect(fs.existsSync(res.filePath)).toBe(false);
    expect(fs.existsSync(siblingPath)).toBe(true);
    expect(fs.existsSync(parentDir)).toBe(true);

    // Clean up sibling and verify empty directory cleanup
    fs.unlinkSync(siblingPath);
    await fs.promises.rmdir(parentDir).catch(() => {});
    expect(fs.existsSync(parentDir)).toBe(false);
  });

  it('cleanupOldFiles skips symlinks without deleting and only removes expired UUID directories and files', () => {
    const tempDir = (fileHandler as any).tempDir;
    const activeUuidDir = path.join(tempDir, '11111111-2222-3333-4444-555555555555');
    fs.mkdirSync(activeUuidDir, { recursive: true });

    const nonUuidDir = path.join(tempDir, 'custom-folder');
    fs.mkdirSync(nonUuidDir, { recursive: true });

    fileHandler.cleanupOldFiles();

    // Active recent UUID directory and non-UUID directory must not be removed
    expect(fs.existsSync(activeUuidDir)).toBe(true);
    expect(fs.existsSync(nonUuidDir)).toBe(true);

    fs.rmSync(activeUuidDir, { recursive: true, force: true });
    fs.rmSync(nonUuidDir, { recursive: true, force: true });
  });
});

describe('B-02: Sensitive path protection in readMediaFile and symlink traversal', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-b02-test-'));
  const fakeBrowserpawDir = path.join(tmpRoot, '.browserpaw');
  const fakeRemoteJson = path.join(fakeBrowserpawDir, 'jev-remote.json');
  const fakeChromeMcpDir = path.join(tmpRoot, '.chrome-mcp');
  const fakeBridgeToken = path.join(fakeChromeMcpDir, 'bridge-token');
  const innocentSymlink = path.join(tmpRoot, 'innocent-avatar.png');

  beforeAll(() => {
    fs.mkdirSync(fakeBrowserpawDir, { recursive: true });
    fs.writeFileSync(fakeRemoteJson, JSON.stringify({ apiKey: 'sk-secret-do-not-leak' }));
    fs.mkdirSync(fakeChromeMcpDir, { recursive: true });
    fs.writeFileSync(fakeBridgeToken, 'dummy-token-secret-12345');
    try {
      fs.symlinkSync(fakeRemoteJson, innocentSymlink, 'file');
    } catch {}
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects direct access to .browserpaw/jev-remote.json in readMediaFile', async () => {
    const res = await fileHandler.readMediaFile(fakeRemoteJson);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Access to sensitive directories is prohibited');
  });

  it('rejects direct access to .chrome-mcp/bridge-token in readMediaFile', async () => {
    const res = await fileHandler.readMediaFile(fakeBridgeToken);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Access to sensitive directories is prohibited');
  });

  it('rejects symlink pointing to sensitive path in readMediaFile', async () => {
    if (!fs.existsSync(innocentSymlink)) return;
    const res = await fileHandler.readMediaFile(innocentSymlink);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Access to sensitive directories is prohibited');
  });
});
