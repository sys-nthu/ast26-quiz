#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/validate-quiz.js <file1.yaml> [file2.yaml ...]');
  process.exit(1);
}

const PR_AUTHOR = (process.env.PR_AUTHOR || '').toLowerCase();
const repoRoot = path.resolve(__dirname, '..');

let allPassed = true;
const markdownParts = ['## \uD83E\uDDF1 Quiz 結構驗證結果\n'];

for (const filePath of files) {
  const absPath = path.resolve(filePath);
  const relPath = path.relative(repoRoot, absPath);
  const basename = path.basename(filePath);
  const quizDir = path.dirname(absPath);

  console.log(`\n驗證中: ${relPath}`);
  markdownParts.push(`### \`${relPath}\`\n`);
  markdownParts.push('| 檢查項目 | 結果 |');
  markdownParts.push('|-------|--------|');

  const results = [];
  let data = null;

  // Check 1: Valid YAML
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    data = yaml.load(content);
    results.push({ name: 'YAML 格式正確', pass: true });
  } catch (e) {
    results.push({ name: 'YAML 格式正確', pass: false, msg: e.message });
  }

  if (!data || typeof data !== 'object') {
    results.push({ name: '必要欄位', pass: false, msg: '無法解析檔案' });
    for (const r of results) {
      const icon = r.pass ? '\u2705' : '\u274C';
      const detail = r.msg ? ` (${r.msg})` : '';
      console.log(`  ${icon} ${r.name}${detail}`);
      markdownParts.push(`| ${r.name} | ${icon}${detail} |`);
    }
    markdownParts.push('');
    markdownParts.push('**結果: \u274C 驗證失敗（解析錯誤）**\n');
    allPassed = false;
    continue;
  }

  // Check 2: Required fields
  const requiredFields = ['author', 'date', 'question', 'options'];
  const missingFields = requiredFields.filter(f => !(f in data));
  results.push({
    name: '必要欄位',
    pass: missingFields.length === 0,
    msg: missingFields.length > 0 ? `缺少: ${missingFields.join(', ')}` : undefined,
  });

  // Check 3: Exactly 4 options
  const options = Array.isArray(data.options) ? data.options : [];
  results.push({
    name: '恰好 4 個選項',
    pass: options.length === 4,
    msg: options.length !== 4 ? `找到 ${options.length} 個選項` : undefined,
  });

  // Check 4: Exactly 1 correct
  const correctCount = options.filter(o => o && o.correct === true).length;
  results.push({
    name: '恰好 1 個正確答案',
    pass: correctCount === 1,
    msg: correctCount !== 1 ? `找到 ${correctCount} 個標記為正確的選項` : undefined,
  });

  // Check 5: Each option has text + explanation
  let optFieldsOk = true;
  let optFieldsMsg = '';
  for (let i = 0; i < options.length; i++) {
    const o = options[i] || {};
    if (!o.text || typeof o.text !== 'string' || o.text.trim().length === 0) {
      optFieldsOk = false;
      optFieldsMsg += `選項 ${i + 1} 缺少 text。`;
    }
    if (!o.explanation || typeof o.explanation !== 'string' || o.explanation.trim().length === 0) {
      optFieldsOk = false;
      optFieldsMsg += `選項 ${i + 1} 缺少 explanation。`;
    }
  }
  results.push({
    name: '每個選項都有 text 和 explanation',
    pass: optFieldsOk,
    msg: optFieldsOk ? undefined : optFieldsMsg.trim(),
  });

  // Check 6: Question substantive (>= 20 chars)
  const question = typeof data.question === 'string' ? data.question.trim() : '';
  results.push({
    name: '題目長度足夠',
    pass: question.length >= 20,
    msg: question.length < 20 ? `僅 ${question.length} 字元（最少 20）` : undefined,
  });

  // Check 7: Each explanation >= 10 chars
  let explOk = true;
  let explMsg = '';
  for (let i = 0; i < options.length; i++) {
    const o = options[i] || {};
    const expl = typeof o.explanation === 'string' ? o.explanation.trim() : '';
    if (expl.length < 10) {
      explOk = false;
      explMsg += `選項 ${i + 1} 的 explanation 太短（${expl.length} 字元）。`;
    }
  }
  results.push({
    name: 'Explanation 長度足夠',
    pass: explOk,
    msg: explOk ? undefined : explMsg.trim(),
  });

  // Check 8: Date valid (YYYY-MM-DD)
  let dateValid = false;
  if (data.date instanceof Date) {
    dateValid = !isNaN(data.date.getTime());
  } else if (typeof data.date === 'string') {
    dateValid = /^\d{4}-\d{2}-\d{2}$/.test(data.date) && !isNaN(new Date(data.date).getTime());
  }
  results.push({
    name: '日期格式正確',
    pass: dateValid,
    msg: dateValid ? undefined : `無效日期: ${data.date}`,
  });

  // Check 9: Author matches PR author
  const yamlAuthor = typeof data.author === 'string' ? data.author.toLowerCase() : '';
  if (PR_AUTHOR) {
    results.push({
      name: 'Author 與 PR 作者一致',
      pass: yamlAuthor === PR_AUTHOR,
      msg: yamlAuthor !== PR_AUTHOR ? `YAML="${data.author}" PR="${PR_AUTHOR}"` : undefined,
    });
  } else {
    results.push({ name: 'Author 與 PR 作者一致', pass: true, msg: '略過（無 PR_AUTHOR 環境變數）' });
  }

  // Check 10: Filename matches author
  const fnameMatch = basename.match(/^q-(.+)-(\d+)\.yaml$/);
  let fnameAuthor = null;
  if (fnameMatch) {
    fnameAuthor = fnameMatch[1].toLowerCase();
  }
  results.push({
    name: '檔名與 author 一致',
    pass: fnameAuthor !== null && fnameAuthor === yamlAuthor,
    msg: fnameAuthor !== yamlAuthor
      ? `檔名 handle="${fnameAuthor}" author="${yamlAuthor}"`
      : undefined,
  });

  // Check 11: Filename unique in target quiz/ directory
  let filenameUnique = true;
  let uniqueMsg;
  try {
    const existingFiles = fs.readdirSync(quizDir);
    const duplicates = existingFiles.filter(f => f === basename);
    filenameUnique = duplicates.length <= 1;
    if (!filenameUnique) {
      uniqueMsg = `在 ${path.relative(repoRoot, quizDir)} 中有重複檔名`;
    }
  } catch {
    filenameUnique = true;
  }
  results.push({
    name: '檔名不重複',
    pass: filenameUnique,
    msg: uniqueMsg,
  });

  // Check 12: Target folder exists
  const folderExists = fs.existsSync(quizDir);
  results.push({
    name: '目標資料夾存在',
    pass: folderExists,
    msg: folderExists ? undefined : `找不到 ${path.relative(repoRoot, quizDir)}`,
  });

  // Output results
  let filePassed = true;
  for (const r of results) {
    const icon = r.pass ? '\u2705' : '\u274C';
    const detail = r.msg ? ` (${r.msg})` : '';
    console.log(`  ${icon} ${r.name}${detail}`);
    markdownParts.push(`| ${r.name} | ${icon}${detail} |`);
    if (!r.pass && !r.msg?.startsWith('略過')) filePassed = false;
  }

  markdownParts.push('');
  if (filePassed) {
    markdownParts.push('**結果: \u2705 所有結構檢查通過**\n');
  } else {
    markdownParts.push('**結果: \u274C 部分檢查未通過**\n');
    allPassed = false;
  }
}

// Write markdown summary for CI
const markdownOutput = markdownParts.join('\n');
fs.writeFileSync(path.join(repoRoot, 'validation-results.md'), markdownOutput);

if (!allPassed) {
  console.log('\n\u274C 驗證失敗');
  process.exit(1);
} else {
  console.log('\n\u2705 所有檔案通過驗證');
}
