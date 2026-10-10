export interface BuildInfo {
  buildId: string;
  buildTime: string;
  sourceHash: string;
  sourceInputs: Record<string, string>;
}

export function createBuildInfo(options?: { repoRoot?: string }): BuildInfo;
export function writeBuildProvenance(
  outDir: string,
  buildInfo: BuildInfo,
): BuildInfo & { artifacts: Record<string, string> };
