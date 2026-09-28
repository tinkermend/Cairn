#!/usr/bin/env node
/**
 * 方案文档目录治理与生命周期自动化检查器 (Spec Directory Governance Watchdog)
 *
 * 对应《识途宪法》（AGENTS.md）中「文档与记录」条款：
 * 1. docs/spec/ 根目录仅维护当前推进中的活跃方案（硬性上限 <= 15 篇），防止上下文膨胀。
 * 2. 检查已完成/已在 CHANGELOG 中闭环的方案是否遗留在根目录，强制归档至 docs/spec/archive/。
 * 3. 确保历史方案归档目录健康完好。
 *
 * docs/spec/ 按本机忽略策略不进仓库，所以本检查只在本机有意义：不挂在 `pnpm check` / CI 上，
 * 目录不存在时直接跳过。用 `pnpm check:specs` 手动运行。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specDir = resolve(root, 'docs/spec');
const archiveDir = resolve(specDir, 'archive');

const MAX_ACTIVE_SPECS = 15;

function runCheck() {
  const issues = [];

  if (!existsSync(specDir)) {
    console.log('ℹ docs/spec/ 不存在（未进仓库的本机目录），跳过方案文档治理检查');
    return;
  }

  if (!existsSync(archiveDir)) {
    issues.push('docs/spec/archive/ 历史归档目录缺失，请创建后隔离历史方案。');
  }

  // 1. 扫描 docs/spec 根目录下的活跃方案
  const allSpecEntries = readdirSync(specDir, { withFileTypes: true });
  const activeSpecFiles = allSpecEntries
    .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map(e => e.name);

  // 2. 检查活跃方案数量
  if (activeSpecFiles.length > MAX_ACTIVE_SPECS) {
    issues.push(
      `docs/spec/ 根目录下活跃方案过多 (${activeSpecFiles.length} 篇 > 上限 ${MAX_ACTIVE_SPECS} 篇)。` +
      `请将已落地、已废弃或历史阶段方案移动至 docs/spec/archive/，避免 AI 读取过时/冗余上下文导致决策偏差。`
    );
  }

  // 3. 读取 CHANGELOG 进行闭环状态比对
  const changelogPath = resolve(root, 'CHANGELOG');
  if (existsSync(changelogPath)) {
    const changelogContent = readFileSync(changelogPath, 'utf8');
    for (const specFile of activeSpecFiles) {
      // 提取前缀代号，例如 CF-00, AI-01, RI-02 等
      const baseName = specFile.replace(/\.md$/, '');
      // 检查文件名或核心关键词是否在 CHANGELOG 中被标记为已闭环开发/落地
      const parts = baseName.split('-');
      // 比如 2026-09-23-ai-01-foundation-and-context
      if (parts.length >= 5) {
        const candidateCode = `${parts[3].toUpperCase()}-${parts[4]}`; // e.g. AI-01, RI-02
        if (candidateCode.match(/^[A-Z]+-\d+/)) {
          const regex = new RegExp(`${candidateCode}[\\s\\S]{0,40}(?<![未没待])(落地|完成|闭环)`, 'i');
          if (regex.test(changelogContent)) {
            issues.push(
              `方案 ${specFile} (代号 ${candidateCode}) 已在 CHANGELOG 中记录为闭环落地，` +
              `请将其移入 docs/spec/archive/ 并从活跃方案目录中归档。`
            );
          }
        }
      }
    }
  }

  // 4. 统计归档目录数量
  let archiveCount = 0;
  if (existsSync(archiveDir)) {
    archiveCount = readdirSync(archiveDir).filter(f => f.endsWith('.md') && f !== 'README.md').length;
  }

  if (issues.length > 0) {
    console.error('❌ 方案文档治理检查失败：');
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }

  console.log(`✅ 方案文档治理检查通过（当前活跃方案 ${activeSpecFiles.length} 篇，归档方案 ${archiveCount} 篇，无膨胀脱节）`);
}

runCheck();
