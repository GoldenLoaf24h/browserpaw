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

export function runBuild(): void {
  // 清理上次构建
  console.log('清理上次构建...');
  try {
    fs.rmSync(distDir, { recursive: true, force: true });
  } catch (err) {
    // 忽略目录不存在的错误
    console.log(err);
  }

  // 创建dist目录
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true }); // 创建logs目录
  console.log('dist 和 dist/logs 目录已创建/确认存在');

  // 编译TypeScript
  console.log('编译TypeScript...');
  execSync('tsc', { stdio: 'inherit' });

  // 复制配置文件
  console.log('复制配置文件...');
  const configSourcePath = path.join(__dirname, '..', 'mcp', 'stdio-config.json');
  const configDestPath = path.join(distDir, 'mcp', 'stdio-config.json');

  try {
    // 确保目标目录存在
    fs.mkdirSync(path.dirname(configDestPath), { recursive: true });

    if (fs.existsSync(configSourcePath)) {
      fs.copyFileSync(configSourcePath, configDestPath);
      console.log(`已将 stdio-config.json 复制到 ${configDestPath}`);
    } else {
      console.error(`错误: 配置文件未找到: ${configSourcePath}`);
    }
  } catch (error) {
    console.error('复制配置文件时出错:', error);
  }

  // 复制package.json并更新其内容
  console.log('准备package.json...');
  const packageJson = require('../../package.json');

  // 复制或生成安装说明
  const pkgReadme = path.join(__dirname, '..', '..', 'README.md');
  if (fs.existsSync(pkgReadme)) {
    fs.copyFileSync(pkgReadme, path.join(distDir, 'README.md'));
  }

  console.log('复制包装脚本...');
  const scriptsSourceDir = path.join(__dirname, '.');
  try {
    copyHostWrapperScripts(scriptsSourceDir, distDir);
    console.log(`已将包装脚本复制到 ${distDir}`);

    // Copy postinstall-guard.js so published npm package has it in dist/scripts
    const guardSrc = path.join(scriptsSourceDir, 'postinstall-guard.js');
    const guardDest = path.join(distDir, 'scripts', 'postinstall-guard.js');
    if (fs.existsSync(guardSrc)) {
      fs.mkdirSync(path.dirname(guardDest), { recursive: true });
      fs.copyFileSync(guardSrc, guardDest);
      console.log(`已将 ${guardSrc} 复制到 ${guardDest}`);
    }
  } catch (error) {
    console.error('复制包装脚本时出错:', error);
    process.exit(1);
  }

  // 为关键JavaScript文件和macOS包装脚本添加可执行权限
  console.log('添加可执行权限...');
  const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh']; // cli.js 假设在 dist 根目录

  filesToMakeExecutable.forEach((file) => {
    const filePath = path.join(distDir, file); // filePath 现在是目标路径
    try {
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, '755');
        console.log(`已为 ${file} 添加可执行权限 (755)`);
      } else {
        console.warn(`警告: ${filePath} 不存在，无法添加可执行权限`);
      }
    } catch (error) {
      console.error(`为 ${file} 添加可执行权限时出错:`, error);
    }
  });

  // Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
  // This is critical for development mode where dist is deleted on each rebuild.
  // The file points to the Node.js executable used during build/installation
  console.log('写入 node_path.txt...');
  const nodePathFile = path.join(distDir, 'node_path.txt');
  fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
  console.log(`已写入 Node.js 路径: ${process.execPath}`);

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
