/**
 * Jev Decision Model Manager & Downloader (Mapika/decider-2b)
 *
 * Responsibilities:
 * - Local model storage resolution (~/.browserpaw/models/decider-2b)
 * - Silent network environment detection (Official HuggingFace vs Domestic Mirror)
 * - Streaming download execution with progress tracking & byte counting
 * - Active Jev Engine routing mode state management ('off' | 'local' | 'remote')
 */

import {
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  createWriteStream,
  openSync,
  unlinkSync,
  promises as fsPromises,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';

export type JevMode = 'off' | 'local' | 'remote';

export const HF_DOMESTIC_MIRRORS = [
  'https://hf-mirror.com',
  'https://hf-mirror.net',
  'https://aifasthub.com',
];

export const HF_OFFICIAL_SOURCE = 'https://huggingface.co';

export const HF_CANDIDATE_MIRRORS = [...HF_DOMESTIC_MIRRORS, HF_OFFICIAL_SOURCE];

export function isHuggingFaceTarget(urlOrRepo?: string): boolean {
  if (!urlOrRepo) return true;
  const trimmed = urlOrRepo.trim();
  if (/^https?:\/\/(www\.)?huggingface\.co\//i.test(trimmed)) return true;
  if (/^https?:\/\/(www\.)?hf-mirror\.(com|net)\//i.test(trimmed)) return true;
  if (/^https?:\/\/(www\.)?aifasthub\.com\//i.test(trimmed)) return true;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return true;
  }
  return false;
}

export interface ModelDownloadProgress {
  status: 'idle' | 'downloading' | 'completed' | 'error';
  percent: number;
  totalBytes: number;
  downloadedBytes: number;
  speed: string;
  currentFile: string;
  error?: string;
  resumed?: boolean;
  selectedSource?: string;
}

export interface ModelStatusInfo {
  downloaded: boolean;
  path: string;
  sizeBytes: number;
  activeMode: JevMode;
  localServiceOnline: boolean;
  models?: string[];
  activeModel?: string;
  remoteConfig?: { baseUrl?: string; apiKey?: string; modelId?: string };
  idleTimeoutMs?: number;
  lastActivityTime?: number;
}

const MODELS_ROOT_DIR = join(homedir(), '.browserpaw', 'models');
const DEFAULT_MODEL_NAME = 'decider-2b';
const BASE_MODELS_PATH = join(MODELS_ROOT_DIR, DEFAULT_MODEL_NAME);
const CONFIG_FILE = join(homedir(), '.browserpaw', 'jev-remote.json');

// Expected model files with approximate sizes
const MODEL_FILES = [
  { name: 'config.json', path: 'config.json' },
  { name: 'tokenizer.json', path: 'tokenizer.json' },
  { name: 'tokenizer_config.json', path: 'tokenizer_config.json' },
  { name: 'model.safetensors', path: 'model.safetensors' },
];

export class JevModelManager {
  private static instance: JevModelManager;
  private activeMode: JevMode = 'remote';
  private activeModelName: string = DEFAULT_MODEL_NAME;
  private remoteConfig: { baseUrl?: string; apiKey?: string; modelId?: string } = {
    modelId: 'jev-latest',
  };
  private progress: ModelDownloadProgress = {
    status: 'idle',
    percent: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: '0 KB/s',
    currentFile: '',
  };
  private isDownloading = false;
  private activeReq: http.ClientRequest | null = null;
  private activeFileStream: any = null;
  private isCancelled = false;
  private isStartingService = false;
  private startServicePromise: Promise<{ success: boolean; message?: string }> | null = null;
  private serviceProcess: any = null;
  private servicePid: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = Date.now();
  public static readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes idle timeout

  private constructor() {
    this.ensureModelDir();
    this.loadRemoteConfig();
    if (process.env.JEV_ACTIVE_MODE === 'local' || process.env.DECIDER_LOCAL === '1') {
      this.activeMode = 'local';
    } else if (
      !this.activeMode ||
      (this.activeMode === 'remote' &&
        !this.remoteConfig.apiKey &&
        !process.env.TYPESAFE_API_KEY &&
        !process.env.JEV_API_KEY)
    ) {
      if (this.isModelDownloaded()) {
        this.activeMode = 'local';
      }
    }
  }

  /**
   * Reset activity timestamp and reschedule 10-minute idle auto-offload
   */
  public touchActivity(): void {
    this.lastActivityTime = Date.now();
    this.scheduleIdleCheck();
    // Non-blocking ping to the python service to sync activity timestamp
    if (typeof fetch === 'function') {
      fetch('http://127.0.0.1:8009/touch', { method: 'POST' }).catch(() => {});
    }
  }

  /**
   * Trigger model preload when any MCP tool is invoked by an agent.
   * If Jev activeMode is 'local' (or auto-local) and weights are downloaded, starts service in background.
   */
  public onToolInvocation(): void {
    this.touchActivity();
    if (this.isModelDownloaded()) {
      const mode = this.getActiveMode();
      if (
        mode === 'local' ||
        (mode !== 'off' &&
          !this.remoteConfig.apiKey &&
          !process.env.TYPESAFE_API_KEY &&
          !process.env.JEV_API_KEY)
      ) {
        if (!this.isStartingService) {
          this.isLocalServiceOnline(8009)
            .then((online) => {
              if (!online && !this.isStartingService) {
                this.ensureLocalServiceRunning().catch((err) => {
                  console.warn('[JevModelManager] Auto-preload error:', err?.message || err);
                });
              }
            })
            .catch(() => {});
        }
      }
    }
  }

  public getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.JEST_WORKER_ID) ||
      Boolean(process.env.VITEST)
    ) {
      return;
    }

    this.idleTimer = setTimeout(async () => {
      const idleTime = Date.now() - this.lastActivityTime;
      if (idleTime >= JevModelManager.IDLE_TIMEOUT_MS) {
        console.log(
          '[JevModelManager] Local decider model idle for 10 minutes. Auto-unloading from memory/VRAM...',
        );
        await this.unloadLocalModel().catch(() => {});
      } else {
        this.scheduleIdleCheck();
      }
    }, JevModelManager.IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private loadRemoteConfig(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      if (existsSync(CONFIG_FILE)) {
        const raw = readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.remoteConfig = {
            ...this.remoteConfig,
            ...parsed,
            modelId: parsed.modelId?.trim() || 'jev-latest',
          };
          if (
            parsed.activeMode === 'off' ||
            parsed.activeMode === 'local' ||
            parsed.activeMode === 'remote'
          ) {
            this.activeMode = parsed.activeMode;
          }
          if (typeof parsed.activeModel === 'string' && parsed.activeModel.trim()) {
            this.activeModelName = parsed.activeModel.trim();
          }
        }
      }
    } catch {
      // Non-blocking fallback
    }
  }

  private saveConfig(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      const dir = join(homedir(), '.browserpaw');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = {
        ...this.remoteConfig,
        activeMode: this.activeMode,
        activeModel: this.activeModelName,
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Ignore
    }
  }

  public static getInstance(): JevModelManager {
    if (!JevModelManager.instance) {
      JevModelManager.instance = new JevModelManager();
    }
    return JevModelManager.instance;
  }

  public getModelPath(): string {
    return BASE_MODELS_PATH;
  }

  public getModelsRootDir(): string {
    return MODELS_ROOT_DIR;
  }

  private ensureModelDir(): void {
    try {
      if (!existsSync(MODELS_ROOT_DIR)) {
        mkdirSync(MODELS_ROOT_DIR, { recursive: true });
      }
    } catch {
      // Ignore
    }
  }

  public getActiveMode(): JevMode {
    return this.activeMode;
  }

  public setActiveMode(mode: JevMode): void {
    if (mode === 'off' || mode === 'local' || mode === 'remote') {
      this.activeMode = mode;
      this.saveConfig();
      if (mode === 'local') {
        this.ensureLocalServiceRunning().catch(() => {});
      } else if (mode === 'off') {
        this.unloadLocalModel().catch(() => {});
      }
    }
  }

  public listModels(): string[] {
    try {
      if (!existsSync(MODELS_ROOT_DIR)) return [];
      const entries = readdirSync(MODELS_ROOT_DIR);
      const dirs = entries.filter((entry) => {
        try {
          const fullPath = join(MODELS_ROOT_DIR, entry);
          return statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });
      return dirs;
    } catch {
      return [];
    }
  }

  public getActiveModel(): string {
    if (this.activeModelName) {
      return this.activeModelName;
    }
    const models = this.listModels();
    if (models.length > 0) {
      this.activeModelName = models[0];
      return this.activeModelName;
    }
    return '';
  }

  public setActiveModel(name: string): boolean {
    if (!name) return false;
    this.activeModelName = name;
    this.saveConfig();
    return true;
  }

  public sanitizeModelName(name: string): string {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Model name is required');
    const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized.includes('..')) {
      throw new Error('Invalid model name');
    }
    return sanitized;
  }

  public async deleteModel(
    name: string,
  ): Promise<{ success: boolean; fallbackModel?: string; message?: string }> {
    if (!name) return { success: false, message: 'Model name is required' };
    let safeName: string;
    try {
      safeName = this.sanitizeModelName(name);
    } catch {
      return { success: false, message: 'Invalid model name parameter' };
    }
    const targetDir = join(MODELS_ROOT_DIR, safeName);
    const resolvedTarget = resolve(targetDir);
    if (!resolvedTarget.startsWith(resolve(MODELS_ROOT_DIR))) {
      return { success: false, message: 'Invalid model path' };
    }
    try {
      if (existsSync(targetDir)) {
        await fsPromises.rm(targetDir, { recursive: true, force: true });
      }
      const remaining = this.listModels();
      if (this.activeModelName === name || this.activeModelName === safeName) {
        this.activeModelName = remaining[0] || '';
      }
      this.saveConfig();
      return { success: true, fallbackModel: this.activeModelName };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to delete model' };
    }
  }

  public setRemoteConfig(config: { baseUrl?: string; apiKey?: string; modelId?: string }): void {
    const rawModel = config.modelId?.trim();
    const sanitizedModelId = !rawModel || rawModel === 'decider-2b' ? 'jev-latest' : rawModel;
    this.remoteConfig = {
      ...this.remoteConfig,
      ...config,
      modelId: sanitizedModelId,
    };
    this.saveConfig();
  }

  public getRemoteConfig(): { baseUrl?: string; apiKey?: string; modelId?: string } {
    const rawModel = this.remoteConfig.modelId?.trim();
    const sanitizedModelId = !rawModel || rawModel === 'decider-2b' ? 'jev-latest' : rawModel;
    return {
      ...this.remoteConfig,
      modelId: sanitizedModelId,
    };
  }

  /**
   * Validate whether the specified or current Jev mode is properly configured and usable.
   * If not usable, provides detailed error diagnosis and actionable remediation.
   */
  public async validateConfiguration(mode?: JevMode): Promise<{
    valid: boolean;
    reason: string;
    message: string;
    diagnostics?: string;
    remediation: string;
  }> {
    const targetMode = mode || this.getActiveMode();
    if (targetMode === 'off') {
      return {
        valid: false,
        reason: 'user_turned_off',
        message:
          'Jev semantic execution is currently turned OFF by the user in the extension popup.',
        remediation:
          'To enable Jev automation, you must explicitly ask the user for confirmation and obtain user authorization first.',
      };
    }

    if (targetMode === 'local') {
      const activeModel = this.getActiveModel();
      if (!this.isModelDownloaded(activeModel)) {
        const expectedDir = join(MODELS_ROOT_DIR, activeModel || DEFAULT_MODEL_NAME);
        return {
          valid: false,
          reason: 'local_model_missing',
          message: `Local Jev model weights '${activeModel}' are not downloaded or incomplete.`,
          diagnostics: `Expected model.safetensors and config.json at: ${expectedDir}`,
          remediation: `Open the BrowserPaw Chrome extension popup, switch to 'Local', and download the '${activeModel}' model, or set environment variable TYPESAFE_API_KEY to use remote cloud mode.`,
        };
      }

      const isOnline = await this.isLocalServiceOnline(8009);
      if (!isOnline) {
        const startRes = await this.ensureLocalServiceRunning();
        if (!startRes.success) {
          return {
            valid: false,
            reason: 'local_service_failed',
            message: `Failed to start local Jev service on port 8009: ${startRes.message || 'Health check timed out'}`,
            diagnostics: `Inspect service log at ${join(homedir(), '.browserpaw', 'decider-service.log')}`,
            remediation: `Check if Python virtualenv at ~/.browserpaw/venv is installed and dependencies (uvicorn, torch, transformers) are ready.`,
          };
        }
      }

      return {
        valid: true,
        reason: 'ready',
        message: 'Local Jev service is running and ready.',
        remediation: '',
      };
    }

    // Remote mode
    const remoteCfg = this.getRemoteConfig();
    const envKey = (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '').trim();
    const activeKey = (remoteCfg.apiKey || envKey || '').trim();

    if (!activeKey) {
      return {
        valid: false,
        reason: 'remote_key_missing',
        message: 'Remote Jev API Key is not configured.',
        diagnostics:
          'Neither remoteConfig.apiKey nor TYPESAFE_API_KEY/JEV_API_KEY environment variable is set.',
        remediation:
          'Set TYPESAFE_API_KEY in your environment or configure your API key in the BrowserPaw extension popup under Remote settings.',
      };
    }

    return {
      valid: true,
      reason: 'ready',
      message: 'Remote Jev configuration is valid.',
      remediation: '',
    };
  }

  public isAvailable(): boolean {
    if (this.activeMode === 'off') return false;
    if (this.activeMode === 'local') return this.isModelDownloaded();
    const envKey = (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '').trim();
    return Boolean(this.remoteConfig.apiKey || envKey);
  }

  /**
   * Check whether model weights are downloaded and ready locally.
   * Model requires model.safetensors (> 1GB) and config.json.
   */
  public isModelDownloaded(modelName?: string): boolean {
    const targetModel = modelName || this.getActiveModel();
    if (!targetModel) return false;
    const targetDir = join(MODELS_ROOT_DIR, targetModel);
    const weightsPath = join(targetDir, 'model.safetensors');
    const configPath = join(targetDir, 'config.json');

    if (!existsSync(weightsPath) || !existsSync(configPath)) {
      return false;
    }

    try {
      const stats = statSync(weightsPath);
      // decider-2b model.safetensors is around 3.78GB. A valid download is at least 1GB.
      return stats.size > 1024 * 1024 * 1024;
    } catch {
      return false;
    }
  }

  /**
   * Check if local decider service (FastAPI on 8009) is listening and healthy.
   */
  public async isLocalServiceOnline(port = 8009): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 800);
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeout);
      return Boolean(res && res.ok);
    } catch {
      return false;
    }
  }

  /**
   * Check whether PyTorch CUDA acceleration is functional on this machine.
   * If CUDA is available, Windows environment is strictly prohibited from entering CPU branch.
   */
  public detectCudaAvailable(pythonBin: string): boolean {
    if (process.env.NODE_ENV === 'test') {
      return process.env.MOCK_CUDA_AVAILABLE === 'true';
    }
    try {
      const { execSync } = require('node:child_process');
      const out = execSync(`"${pythonBin}" -c "import torch; print(torch.cuda.is_available())"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4000,
        windowsHide: true,
      }).trim();
      return out.toLowerCase().includes('true');
    } catch {
      return false;
    }
  }

  /**
   * Terminate any lingering/orphan process listening on a local port.
   */
  public async killProcessOnPort(port = 8009): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      if (process.platform === 'win32') {
        const { execSync } = await import('node:child_process');
        const output = execSync('netstat -ano -p tcp', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = output.split('\n');
        const pids = new Set<string>();
        for (const line of lines) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1]?.trim();
            if (pid && /^\d+$/.test(pid) && pid !== '0') {
              pids.add(pid);
            }
          }
        }
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
          } catch {}
        }
      } else {
        const { execSync } = await import('node:child_process');
        try {
          execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' });
        } catch {}
      }
    } catch {}
  }

  /**
   * Ensure local decider service is running (hot-load & background resident).
   * Spawns uvicorn process detached if offline and waits for health readiness.
   */
  public async ensureLocalServiceRunning(): Promise<{ success: boolean; message?: string }> {
    if (
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.JEST_WORKER_ID) ||
      Boolean(process.env.VITEST)
    ) {
      return { success: false, message: 'Test environment: skipped auto-spawn' };
    }

    const online = await this.isLocalServiceOnline(8009);
    if (online) {
      if (!this.idleTimer) {
        this.scheduleIdleCheck();
      }
      return { success: true, message: 'Local Jev service is already running' };
    }

    if (this.isStartingService && this.startServicePromise) {
      return this.startServicePromise;
    }

    this.isStartingService = true;
    this.startServicePromise = this._startLocalServiceInternal();
    try {
      return await this.startServicePromise;
    } finally {
      this.isStartingService = false;
      this.startServicePromise = null;
    }
  }

  private async _startLocalServiceInternal(): Promise<{ success: boolean; message?: string }> {
    const activeModel = this.getActiveModel();
    if (!this.isModelDownloaded(activeModel)) {
      return {
        success: false,
        message: `Local model weights not found at ${join(MODELS_ROOT_DIR, activeModel || '')}`,
      };
    }

    const home = homedir();
    const isWin = process.platform === 'win32';
    const venvPython = isWin
      ? join(home, '.browserpaw', 'venv', 'Scripts', 'python.exe')
      : join(home, '.browserpaw', 'venv', 'bin', 'python');

    const pythonBin = existsSync(venvPython) ? venvPython : isWin ? 'python' : 'python3';

    const logPath = join(home, '.browserpaw', 'decider-service.log');
    let logFd: number | undefined;
    try {
      logFd = openSync(logPath, 'a');
    } catch {
      // Ignore
    }

    const modelDir = join(MODELS_ROOT_DIR, activeModel);
    const deciderRepoDir = join(home, '.browserpaw', 'decider-repo');

    // 1. Resolve target device. Strict Rule: On Windows, GPU/CUDA is strictly prioritized over CPU.
    let targetDevice = process.env.DECIDER_DEVICE?.trim();
    if (!targetDevice) {
      if (isWin) {
        // Windows environment: Verify CUDA capability.
        // If CUDA is available, STRICTLY set to 'cuda', completely forbidding CPU priority.
        const cudaOk = this.detectCudaAvailable(pythonBin);
        if (cudaOk) {
          targetDevice = 'cuda';
        } else {
          console.warn(
            '[JevModelManager] Diagnostic Warning: PyTorch CUDA is not available on this Windows host. Falling back to CPU.',
          );
          targetDevice = 'cpu';
        }
      } else if (process.platform === 'darwin') {
        targetDevice = 'mps';
      } else {
        const cudaOk = this.detectCudaAvailable(pythonBin);
        targetDevice = cudaOk ? 'cuda' : 'cpu';
      }
    }

    const spawnServiceWithDevice = async (
      device: string,
    ): Promise<{ success: boolean; message?: string }> => {
      const env = {
        ...process.env,
        DECIDER_MODEL: modelDir,
        DECIDER_DEVICE: device,
        DECIDER_WARMUP: '0',
        DECIDER_IDLE_TIMEOUT: String(JevModelManager.IDLE_TIMEOUT_MS / 1000),
        PYTHONPATH: existsSync(deciderRepoDir)
          ? `${deciderRepoDir}${isWin ? ';' : ':'}${process.env.PYTHONPATH || ''}`
          : process.env.PYTHONPATH || '',
      };

      const child = spawn(
        pythonBin,
        ['-m', 'uvicorn', 'decider.serve:app', '--host', '127.0.0.1', '--port', '8009'],
        {
          detached: true,
          cwd: existsSync(deciderRepoDir) ? deciderRepoDir : home,
          stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
          env,
          windowsHide: true,
        },
      );
      this.serviceProcess = child;
      this.servicePid = child.pid || null;
      if (child.pid) {
        try {
          const pidFile = join(home, '.browserpaw', 'decider-service.pid');
          writeFileSync(pidFile, String(child.pid), 'utf8');
        } catch {}
      }
      child.unref();

      let exitedEarly = false;
      let exitCode: number | null = null;
      const onExit = (code: number | null) => {
        exitedEarly = true;
        exitCode = code;
      };
      child.once('exit', onExit);

      // Poll /health up to 30 seconds (check every 300ms)
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (exitedEarly) {
          break;
        }
        const ready = await this.isLocalServiceOnline(8009);
        if (ready) {
          child.removeListener('exit', onExit);
          this.touchActivity();
          return {
            success: true,
            message: `Local Jev service started successfully on ${device.toUpperCase()}`,
          };
        }
      }

      child.removeListener('exit', onExit);

      // Check log file for CUDA OOM or CUDA initialization failure signals
      let hasCudaOomOrError = false;
      try {
        if (existsSync(logPath)) {
          const logs = readFileSync(logPath, 'utf8');
          const recentLogs = logs.slice(-2048);
          hasCudaOomOrError =
            /CUDA out of memory|OutOfMemoryError|CUDA error|torch\.cuda\.is_available\(\) is False/i.test(
              recentLogs,
            );
        }
      } catch {}

      return {
        success: false,
        message: exitedEarly
          ? `Decider service exited prematurely with code ${exitCode} (device=${device}, cudaError=${hasCudaOomOrError})`
          : `Timeout waiting for local Jev decider service on port 8009 to become ready (device=${device})`,
      };
    };

    try {
      // Step A: Attempt primary spawn (enforcing GPU/CUDA first on Windows)
      let startRes = await spawnServiceWithDevice(targetDevice);

      // Step B: Only if device was 'cuda' and startup clearly failed due to CUDA error/OOM, fallback to CPU
      if (!startRes.success && targetDevice === 'cuda' && !process.env.DECIDER_DEVICE) {
        console.warn(
          `[JevModelManager] Diagnostic Warning: Failed to initialize Jev service on GPU/CUDA (${startRes.message}). Falling back to CPU mode...`,
        );
        await this.killProcessOnPort(8009);
        targetDevice = 'cpu';
        startRes = await spawnServiceWithDevice('cpu');
        if (startRes.success) {
          console.warn('[JevModelManager] Jev decider service successfully fell back to CPU.');
        }
      }

      return startRes;
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to spawn decider service: ${err?.message || err}`,
      };
    }
  }

  /**
   * Unload local model and stop local decider service, completely releasing GPU VRAM & memory.
   */
  public async unloadLocalModel(): Promise<{ success: boolean; message: string }> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      await fetch('http://127.0.0.1:8009/unload', {
        method: 'POST',
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeout);
    } catch {}

    // Allow process a brief moment to exit cleanly
    await new Promise((r) => setTimeout(r, 200));

    // Check if process is still alive and kill if needed
    const home = homedir();
    const pidFile = join(home, '.browserpaw', 'decider-service.pid');
    let pidToKill = this.servicePid;
    if (!pidToKill && existsSync(pidFile)) {
      try {
        const raw = readFileSync(pidFile, 'utf8').trim();
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) pidToKill = parsed;
      } catch {}
    }

    if (pidToKill) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/F', '/T', '/PID', String(pidToKill)], { windowsHide: true });
        } else {
          process.kill(pidToKill, 'SIGKILL');
        }
      } catch {}
    }

    // Kill any orphan process still holding port 8009 to strictly free GPU VRAM
    await this.killProcessOnPort(8009);

    try {
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch {}

    this.serviceProcess = null;
    this.servicePid = null;

    return {
      success: true,
      message: 'Local Jev model has been unloaded from GPU VRAM and memory.',
    };
  }

  /**
   * Alias for unloadLocalModel
   */
  public async stopLocalService(): Promise<{ success: boolean; message: string }> {
    return this.unloadLocalModel();
  }

  public async getStatus(): Promise<ModelStatusInfo> {
    const activeModel = this.getActiveModel();
    const downloaded = Boolean(activeModel && this.isModelDownloaded(activeModel));
    let sizeBytes = 0;
    try {
      if (activeModel) {
        const weightsPath = join(MODELS_ROOT_DIR, activeModel, 'model.safetensors');
        if (existsSync(weightsPath)) {
          sizeBytes = statSync(weightsPath).size;
        }
      }
    } catch {}

    const localServiceOnline = await this.isLocalServiceOnline();
    if (localServiceOnline && !this.idleTimer) {
      this.scheduleIdleCheck();
    }

    return {
      downloaded,
      path: activeModel ? join(MODELS_ROOT_DIR, activeModel) : MODELS_ROOT_DIR,
      sizeBytes,
      activeMode: this.activeMode,
      localServiceOnline,
      models: this.listModels(),
      activeModel,
      remoteConfig: this.getRemoteConfig(),
      idleTimeoutMs: JevModelManager.IDLE_TIMEOUT_MS,
      lastActivityTime: this.lastActivityTime,
    };
  }

  public getProgress(): ModelDownloadProgress {
    return { ...this.progress };
  }

  /**
   * Check if user has domestic network connectivity by probing domestic-only endpoints.
   */
  public async isDomesticNetworkReachable(): Promise<boolean> {
    const domesticProbes = ['https://www.baidu.com', 'https://www.bilibili.com'];
    try {
      const probePromises = domesticProbes.map(async (site) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        try {
          const res = await fetch(site, {
            method: 'HEAD',
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res && (res.ok || (res.status >= 200 && res.status < 400))) {
            return true;
          }
          throw new Error('Not reachable');
        } catch (err) {
          clearTimeout(timeout);
          throw err;
        }
      });
      return await new Promise<boolean>((resolve) => {
        let remaining = probePromises.length;
        if (remaining === 0) return resolve(false);
        for (const p of probePromises) {
          p.then((ok) => {
            if (ok) resolve(true);
            else if (--remaining === 0) resolve(false);
          }).catch(() => {
            if (--remaining === 0) resolve(false);
          });
        }
      });
    } catch {
      return false;
    }
  }

  /**
   * Domestic acceleration detection:
   * 1. First probe domestic network connectivity (baidu.com / bilibili.com).
   * 2. If reachable: test ONLY domestic acceleration mirrors (hf-mirror.com, hf-mirror.net, aifasthub.com).
   *    Never probe foreign official source here so users with VPN/proxy won't waste their airport bandwidth!
   * 3. If domestic ping fails (overseas environment): fallback to official huggingface.co.
   */
  public async detectOptimalBaseUrl(repo: string = 'Mapika/decider-2b'): Promise<string> {
    const isDomestic = await this.isDomesticNetworkReachable();

    if (isDomestic) {
      // Domestic network reachable: probe ONLY domestic acceleration mirrors
      const probePromises = HF_DOMESTIC_MIRRORS.map(async (mirror) => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1800);
          const probeUrl = `${mirror}/${repo}/raw/main/config.json`;
          const res = await fetch(probeUrl, {
            method: 'HEAD',
            signal: controller.signal,
          }).catch(() => null);
          clearTimeout(timeout);
          const latency = Date.now() - start;
          if (res && (res.ok || (res.status >= 200 && res.status < 400))) {
            return { mirror, latency, ok: true };
          }
          return { mirror, latency: 99999, ok: false };
        } catch {
          return { mirror, latency: 99999, ok: false };
        }
      });

      const probeResults = await Promise.all(probePromises);
      const reachable = probeResults.filter((r) => r.ok).sort((a, b) => a.latency - b.latency);

      if (reachable.length > 0) {
        return reachable[0].mirror;
      }

      // If all domestic mirror probes timed out or failed, default to hf-mirror.com
      return 'https://hf-mirror.com';
    }

    // Not domestic: user is outside mainland China / domestic ping failed -> Fallback to official HuggingFace
    return HF_OFFICIAL_SOURCE;
  }

  /**
   * Cancel any active model download and close network/file streams cleanly.
   */
  public cancelDownload(): { success: boolean; message: string } {
    if (!this.isDownloading) {
      return { success: true, message: 'No active download in progress.' };
    }
    this.isCancelled = true;
    if (this.activeReq) {
      try {
        this.activeReq.destroy();
      } catch {}
      this.activeReq = null;
    }
    if (this.activeFileStream) {
      try {
        this.activeFileStream.close();
      } catch {}
      this.activeFileStream = null;
    }
    this.isDownloading = false;
    this.progress = {
      status: 'idle',
      percent: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      speed: '0 KB/s',
      currentFile: '',
      error: undefined,
    };
    return { success: true, message: 'Download cancelled successfully.' };
  }

  /**
   * Start downloading a model (decider-2b or custom repo/URL).
   * Runs asynchronously in the background.
   */
  public startDownload(customRepoOrUrl?: string): {
    success: boolean;
    message: string;
    modelName?: string;
  } {
    if (this.isDownloading) {
      return { success: false, message: 'Download already in progress.' };
    }

    const trimmed = customRepoOrUrl?.trim();
    if (!trimmed && this.isModelDownloaded()) {
      this.progress = {
        status: 'completed',
        percent: 100,
        totalBytes: 0,
        downloadedBytes: 0,
        speed: '0 KB/s',
        currentFile: '',
      };
      return {
        success: true,
        message: 'Model is already downloaded.',
        modelName: DEFAULT_MODEL_NAME,
      };
    }

    this.isDownloading = true;
    this.isCancelled = false;
    this.progress = {
      status: 'downloading',
      percent: 0,
      totalBytes: 3.8 * 1024 * 1024 * 1024, // Estimate 3.8GB
      downloadedBytes: 0,
      speed: 'Connecting...',
      currentFile: 'Probing mirrors...',
    };

    // Fire and forget
    this.executeDownloadPipeline(trimmed).catch((err) => {
      this.isDownloading = false;
      if (this.isCancelled) {
        this.progress.status = 'idle';
        this.progress.speed = '0 KB/s';
        this.progress.error = undefined;
      } else {
        this.progress.status = 'error';
        this.progress.error = err?.message || String(err);
      }
    });

    return { success: true, message: 'Download initiated.' };
  }

  private async executeDownloadPipeline(customRepoOrUrl?: string): Promise<void> {
    this.ensureModelDir();
    this.isCancelled = false;

    let repo = 'Mapika/decider-2b';
    let modelName = DEFAULT_MODEL_NAME;
    const isHF = isHuggingFaceTarget(customRepoOrUrl);

    if (customRepoOrUrl && customRepoOrUrl.trim()) {
      let raw = customRepoOrUrl.trim();
      if (isHF) {
        raw = raw.replace(/^https?:\/\/huggingface\.co\//, '');
        raw = raw.replace(/^https?:\/\/hf-mirror\.(com|net)\//, '');
        raw = raw.replace(/^https?:\/\/aifasthub\.com\//, '');
        raw = raw.replace(/\/+$/, '');
        if (raw.includes('/')) {
          repo = raw;
          const parts = raw.split('/');
          modelName = parts[parts.length - 1];
        } else {
          modelName = raw;
          repo = `Mapika/${raw}`;
        }
      } else {
        // Direct non-HF custom URL (e.g. ModelScope, direct file host, etc.)
        try {
          const u = new URL(raw);
          const pathname = u.pathname.replace(/\/+$/, '');
          const segs = pathname.split('/');
          modelName = segs[segs.length - 1] || 'custom-model';
          modelName = modelName.replace(/\.[^/.]+$/, '');
        } catch {
          modelName = 'custom-model';
        }
      }
    }

    modelName = this.sanitizeModelName(modelName);
    const targetModelDir = join(MODELS_ROOT_DIR, modelName);
    const resolvedTarget = resolve(targetModelDir);
    if (!resolvedTarget.startsWith(resolve(MODELS_ROOT_DIR))) {
      throw new Error('Invalid model directory path');
    }
    if (!existsSync(targetModelDir)) {
      mkdirSync(targetModelDir, { recursive: true });
    }

    let baseUrl = '';
    if (isHF) {
      this.progress.currentFile = 'Probing optimal mirror...';
      baseUrl = await this.detectOptimalBaseUrl(repo);
      try {
        this.progress.selectedSource = new URL(baseUrl).hostname;
      } catch {
        this.progress.selectedSource = baseUrl;
      }
    } else {
      baseUrl = customRepoOrUrl!.trim();
      try {
        this.progress.selectedSource = new URL(baseUrl).hostname;
      } catch {
        this.progress.selectedSource = 'direct';
      }
    }

    if (this.isCancelled) {
      return;
    }

    const downloadFiles = async (sourceBaseUrl: string) => {
      // Determine files to download
      const isDirectFile = !isHF && /\.(safetensors|bin|onnx|gguf)$/i.test(sourceBaseUrl);

      if (isDirectFile) {
        const fileName = 'model.safetensors';
        const targetPath = join(targetModelDir, fileName);
        this.progress.currentFile = fileName;

        await this.downloadSingleFileWithRetry(sourceBaseUrl, targetPath, (bytes, total) => {
          this.progress.downloadedBytes = bytes;
          if (total > 0) this.progress.totalBytes = total;
          this.progress.percent = Math.min(
            99,
            Math.max(
              1,
              Math.round(
                (this.progress.downloadedBytes / Math.max(1, this.progress.totalBytes)) * 100,
              ),
            ),
          );
        });

        const configPath = join(targetModelDir, 'config.json');
        if (!existsSync(configPath)) {
          await fsPromises.writeFile(
            configPath,
            JSON.stringify({ model_type: 'decider', name: modelName }, null, 2),
          );
        }
      } else {
        // Download files in sequence
        for (let i = 0; i < MODEL_FILES.length; i++) {
          if (this.isCancelled) return;
          const file = MODEL_FILES[i];
          const targetPath = join(targetModelDir, file.path);
          const fileUrl = isHF
            ? `${sourceBaseUrl}/${repo}/resolve/main/${file.path}`
            : `${sourceBaseUrl.replace(/\/+$/, '')}/${file.path}`;

          this.progress.currentFile = file.name;

          await this.downloadSingleFileWithRetry(fileUrl, targetPath, (bytes, total) => {
            if (file.name === 'model.safetensors') {
              this.progress.downloadedBytes = bytes;
              if (total > 0) this.progress.totalBytes = total;
              this.progress.percent = Math.min(
                99,
                Math.max(
                  1,
                  Math.round(
                    (this.progress.downloadedBytes / Math.max(1, this.progress.totalBytes)) * 100,
                  ),
                ),
              );
            } else {
              // Metadata files constitute the initial 2%
              this.progress.percent = Math.min(2, Math.round(((i + 1) / MODEL_FILES.length) * 2));
            }
          });
        }
      }
    };

    try {
      await downloadFiles(baseUrl);
    } catch (err: any) {
      if (this.isCancelled) return;
      // If domestic mirror download failed, fallback to official HuggingFace
      if (isHF && baseUrl !== HF_OFFICIAL_SOURCE) {
        console.warn(
          `[JevModelManager] Domestic mirror ${baseUrl} failed: ${err?.message}. Falling back to official source ${HF_OFFICIAL_SOURCE}...`,
        );
        this.progress.selectedSource = `${new URL(HF_OFFICIAL_SOURCE).hostname} (fallback)`;
        this.progress.speed = 'Falling back to official...';
        await downloadFiles(HF_OFFICIAL_SOURCE);
      } else {
        throw err;
      }
    }

    if (this.isCancelled) {
      return;
    }

    this.activeModelName = modelName;
    this.progress.percent = 100;
    this.progress.status = 'completed';
    this.progress.speed = 'Done';
    this.isDownloading = false;
  }

  private downloadSingleFileWithRetry(
    url: string,
    dest: string,
    onProgress: (downloaded: number, total: number) => void,
    retries = 3,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tempDest = `${dest}.downloading`;
      let speedInterval: any = null;

      const cleanup = () => {
        if (speedInterval) {
          clearInterval(speedInterval);
          speedInterval = null;
        }
        if (this.activeReq) {
          try {
            this.activeReq.destroy();
          } catch {}
          this.activeReq = null;
        }
        if (this.activeFileStream) {
          try {
            this.activeFileStream.close();
          } catch {}
          this.activeFileStream = null;
        }
      };

      const makeRequest = (targetUrl: string, currentAttempt: number) => {
        if (this.isCancelled) {
          cleanup();
          return reject(new Error('Download cancelled by user'));
        }

        let existingBytes = 0;
        try {
          if (existsSync(tempDest)) {
            existingBytes = statSync(tempDest).size;
          }
        } catch {
          existingBytes = 0;
        }

        const client = targetUrl.startsWith('https') ? https : http;
        const urlObj = new URL(targetUrl);
        const headers: Record<string, string> = {
          'User-Agent': 'BrowserPaw-JevDownloader/1.0',
        };
        if (existingBytes > 0) {
          headers['Range'] = `bytes=${existingBytes}-`;
        }

        const req = client.request(
          {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers,
          },
          (res) => {
            if (this.isCancelled) {
              cleanup();
              return reject(new Error('Download cancelled by user'));
            }

            // Handle 301 / 302 / 307 / 308 redirects (common in HuggingFace CDN)
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              const redirectUrl = new URL(res.headers.location, targetUrl).toString();
              res.resume();
              return makeRequest(redirectUrl, currentAttempt);
            }

            // 416 Range Not Satisfiable (corrupt or already finished temp file)
            if (res.statusCode === 416) {
              res.resume();
              try {
                if (existsSync(tempDest)) unlinkSync(tempDest);
              } catch {}
              if (currentAttempt < retries) {
                return setTimeout(() => makeRequest(targetUrl, currentAttempt + 1), 1000);
              }
              cleanup();
              return reject(new Error(`HTTP 416 Range Not Satisfiable for ${targetUrl}`));
            }

            if (res.statusCode && res.statusCode >= 400) {
              res.resume();
              if (currentAttempt < retries && !this.isCancelled) {
                return setTimeout(() => makeRequest(targetUrl, currentAttempt + 1), 1500);
              }
              cleanup();
              return reject(new Error(`HTTP ${res.statusCode} when downloading ${targetUrl}`));
            }

            const isRange = res.statusCode === 206;
            this.progress.resumed = isRange;

            let downloaded = isRange ? existingBytes : 0;
            let totalBytes = 0;

            const contentRange = res.headers['content-range'];
            if (contentRange) {
              const match = contentRange.match(/\/(\d+)$/);
              if (match) {
                totalBytes = parseInt(match[1], 10);
              }
            }
            if (!totalBytes) {
              const cl = parseInt(res.headers['content-length'] || '0', 10);
              totalBytes = downloaded + cl;
            }

            const fileStream = createWriteStream(tempDest, {
              flags: isRange ? 'a' : 'w',
            });
            this.activeFileStream = fileStream;

            let lastBytes = downloaded;
            speedInterval = setInterval(() => {
              if (this.isCancelled) {
                cleanup();
                return;
              }
              const bytesDiff = downloaded - lastBytes;
              const kbPerSec = bytesDiff / 1024;
              if (kbPerSec > 1024) {
                this.progress.speed = `${(kbPerSec / 1024).toFixed(1)} MB/s`;
              } else {
                this.progress.speed = `${Math.round(kbPerSec)} KB/s`;
              }
              lastBytes = downloaded;
            }, 1000);

            res.on('data', (chunk) => {
              if (this.isCancelled) {
                cleanup();
                return;
              }
              downloaded += chunk.length;
              onProgress(downloaded, totalBytes);
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
              if (speedInterval) clearInterval(speedInterval);
              this.activeFileStream = null;
              this.activeReq = null;

              if (this.isCancelled) {
                return reject(new Error('Download cancelled by user'));
              }

              fileStream.close(async () => {
                try {
                  if (existsSync(dest)) {
                    try {
                      unlinkSync(dest);
                    } catch {
                      await fsPromises.unlink(dest).catch(() => {});
                    }
                  }
                  await fsPromises.rename(tempDest, dest);
                  resolve();
                } catch (renameErr) {
                  reject(renameErr);
                }
              });
            });

            fileStream.on('error', (err) => {
              cleanup();
              reject(err);
            });
          },
        );

        this.activeReq = req;

        req.on('error', (err) => {
          cleanup();
          if (this.isCancelled) {
            return reject(new Error('Download cancelled by user'));
          }
          if (currentAttempt < retries) {
            return setTimeout(() => makeRequest(targetUrl, currentAttempt + 1), 2000);
          }
          reject(err);
        });

        req.end();
      };

      makeRequest(url, 1);
    });
  }
}

export const jevModelManager = JevModelManager.getInstance();

export async function resolveOptimalDownloadUrl(): Promise<string> {
  return jevModelManager.detectOptimalBaseUrl();
}
