export interface BuildInfo {
  buildId: string;
  buildTime: string;
  buildMode: 'production' | 'development';
  sourceHash: string;
  identityHash: string;
  sourceInputs: Record<string, string>;
}

export function createBuildInfo(options?: {
  repoRoot?: string;
  extensionKey?: string;
  buildMode?: 'production' | 'development';
}): BuildInfo;
export function writeBuildProvenance(
  outDir: string,
  buildInfo: BuildInfo,
): BuildInfo & { artifacts: Record<string, string> };
