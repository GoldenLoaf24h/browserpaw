import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = path.join(__dirname, '..', '..', 'dist');

// QUAL-01: Ensure required host wrapper scripts are verified and copied fail-fast
export function copyHostWrapperScripts(srcDir: string, destDir: string): void {
  const macSrc = path.join(srcDir, 'run_host.sh');
  const winSrc = path.join(srcDir, 'run_host.bat');
  if (!fs.existsSync(macSrc)) {
    throw new Error(`[QUAL-01] Required macOS wrapper script missing: ${macSrc}`);
  }
  if (!fs.existsSync(winSrc)) {
    throw new Error(`[QUAL-01] Required Windows wrapper script missing: ${winSrc}`);
  }
  fs.copyFileSync(macSrc, path.join(destDir, 'run_host.sh'));
  fs.copyFileSync(winSrc, path.join(destDir, 'run_host.bat'));
}

export function cleanDistDir(targetDir: string): void {
  if (!fs.existsSync(targetDir)) {
    return;
  }
  // Clear contents while keeping root intact to avoid Windows EBUSY when process cwd is pinned to targetDir
  const entries = fs.readdirSync(targetDir);
  for (const entry of entries) {
    fs.rmSync(path.join(targetDir, entry), {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
  }
}

export function runBuild(): void {
  // Clean previous build
  console.log('清理上次构建...');
  cleanDistDir(distDir);

  // Create dist directory
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true }); // Create logs directory
  console.log('dist 和 dist/logs 目录已创建/确认存在');

  // Compile TypeScript
  console.log('编译TypeScript...');
  execSync('tsc', { stdio: 'inherit' });

  // Copy configuration files
  console.log('复制配置文件...');
  const configSourcePath = path.join(__dirname, '..', 'mcp', 'stdio-config.json');
  const configDestPath = path.join(distDir, 'mcp', 'stdio-config.json');

  try {
    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(configDestPath), { recursive: true });

    if (fs.existsSync(configSourcePath)) {
      fs.copyFileSync(configSourcePath, configDestPath);
      console.log(`Copied stdio-config.json to ${configDestPath}`);
    } else {
      console.error(`Error: Configuration file not found: ${configSourcePath}`);
    }
  } catch (error) {
    console.error('复制配置文件时出错:', error);
  }

  // Prepare package.json
  console.log('准备package.json...');
  const packageJson = require('../../package.json');

  // Copy installation instructions
  const pkgReadme = path.join(__dirname, '..', '..', 'README.md');
  if (fs.existsSync(pkgReadme)) {
    fs.copyFileSync(pkgReadme, path.join(distDir, 'README.md'));
  }

  console.log('复制包装脚本...');
  const scriptsSourceDir = path.join(__dirname, '.');
  try {
    copyHostWrapperScripts(scriptsSourceDir, distDir);
    console.log(`Copied wrapper scripts to ${distDir}`);

    // Copy postinstall-guard.js so published npm package has it in dist/scripts
    const guardSrc = path.join(scriptsSourceDir, 'postinstall-guard.js');
    const guardDest = path.join(distDir, 'scripts', 'postinstall-guard.js');
    if (fs.existsSync(guardSrc)) {
      fs.mkdirSync(path.dirname(guardDest), { recursive: true });
      fs.copyFileSync(guardSrc, guardDest);
      console.log(`Copied ${guardSrc} to ${guardDest}`);
    }
  } catch (error) {
    console.error('复制包装脚本时出错:', error);
    process.exit(1);
  }

  // Add executable permissions for key JavaScript files and shell scripts
  console.log('添加可执行权限...');
  const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh']; // cli.js assumed at dist root

  filesToMakeExecutable.forEach((file) => {
    const filePath = path.join(distDir, file); // filePath target
    try {
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, '755');
        console.log(`Added executable permissions (755) to ${file}`);
      } else {
        console.warn(`Warning: ${filePath} does not exist, cannot set permissions`);
      }
    } catch (error) {
      console.error(`Error setting executable permissions for ${file}:`, error);
    }
  });

  // Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
  // This is critical for development mode where dist is deleted on each rebuild.
  // The file points to the Node.js executable used during build/installation
  console.log('写入 node_path.txt...');
  const nodePathFile = path.join(distDir, 'node_path.txt');
  fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
  console.log(`Saved Node.js path: ${process.execPath}`);

  console.log('✅ 构建完成');
}

if (!process.env.JEST_WORKER_ID) {
  try {
    runBuild();
  } catch (err) {
    console.error('构建失败:', err);
    process.exit(1);
  }
}
