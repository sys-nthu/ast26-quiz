#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Anthropic = require('@anthropic-ai/sdk');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/claude-review.js <file1.yaml> [file2.yaml ...]');
  process.exit(0); // advisory — don't block
}

const repoRoot = path.resolve(__dirname, '..');

// Load .env if present (for local testing)
const envPath = path.join(repoRoot, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        const val = trimmed.slice(eqIdx + 1);
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY not set — skipping AI review');
  const md = '## \uD83E\uDD16 AI 題目審查\n\n> AI 審查不可用 — 未設定 `ANTHROPIC_API_KEY`，請人工審查。\n\n---\n_審查由 Claude (claude-opus-4-20250514) 執行。此為建議性質，最終由助教或老師決定是否 merge。_\n';
  fs.writeFileSync(path.join(repoRoot, 'claude-review-results.md'), md);
  process.exit(0);
}

// Strip X-Stainless-* headers and Anthropic/JS User-Agent that trigger
// Cloudflare bot detection when using cliproxy through a Cloudflare tunnel.
const client = new Anthropic({
  apiKey,
  fetch: (url, init) => {
    if (init && init.headers) {
      const clean = {};
      for (const [k, v] of Object.entries(init.headers)) {
        if (k.startsWith('x-stainless')) continue;
        clean[k] = (k === 'user-agent') ? 'node-fetch/1.0' : v;
      }
      init.headers = clean;
    }
    return globalThis.fetch(url, init);
  },
});

const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://lego.sys-nthu.tw';

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Strip HTML tags to get rough text content
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000); // cap to avoid blowing up context
  } catch (err) {
    console.log(`  無法取得 ${url}: ${err.message}`);
    return null;
  }
}

async function reviewFile(filePath) {
  const absPath = path.resolve(filePath);
  const relPath = path.relative(repoRoot, absPath);
  const basename = path.basename(filePath);
  const quizDir = path.dirname(absPath);

  // Extract pillar/concept from path
  const pathParts = relPath.split(path.sep);
  // Expected: docs/<pillar>/<concept>/quiz/<file>
  const docsIdx = pathParts.indexOf('docs');
  const pillar = docsIdx >= 0 ? pathParts[docsIdx + 1] : 'unknown';
  const concept = docsIdx >= 0 ? pathParts[docsIdx + 2] : 'unknown';

  // Read new file
  const newContent = fs.readFileSync(absPath, 'utf8');

  // Fetch concept page and handout for scope checking
  const conceptUrl = `${SITE_BASE_URL}/${pillar}/${concept}`;
  const handoutUrl = `${SITE_BASE_URL}/handouts/${pillar}/${concept}`;
  console.log(`  取得主題頁面: ${conceptUrl}`);
  console.log(`  取得講義: ${handoutUrl}`);
  const [conceptPageText, handoutText] = await Promise.all([
    fetchPageText(conceptUrl),
    fetchPageText(handoutUrl),
  ]);

  // Read all existing q-*.yaml files in the same quiz/ directory (excluding the new file)
  let existingFiles = [];
  try {
    const allFiles = fs.readdirSync(quizDir)
      .filter(f => f.startsWith('q-') && f.endsWith('.yaml') && f !== basename)
      .sort();

    let truncated = false;
    let filesToRead = allFiles;
    if (allFiles.length > 50) {
      filesToRead = allFiles.slice(-20); // 20 most recent
      truncated = true;
    }

    for (const f of filesToRead) {
      const content = fs.readFileSync(path.join(quizDir, f), 'utf8');
      existingFiles.push({ filename: f, content });
    }

    if (truncated) {
      console.log(`  注意: 共 ${allFiles.length} 個既有檔案，僅顯示最近 20 個`);
    }
  } catch {
    // no existing files
  }

  const existingSection = existingFiles.length > 0
    ? existingFiles.map(f => `### ${f.filename}\n\`\`\`yaml\n${f.content}\`\`\``).join('\n\n')
    : '（無）';

  const conceptSection = conceptPageText
    ? `## 主題頁面內容（${conceptUrl}）\n${conceptPageText}`
    : `## 主題頁面內容\n（無法取得，請略過範圍檢查）`;

  const handoutSection = handoutText
    ? `## 講義內容（${handoutUrl}）\n${handoutText}`
    : `## 講義內容\n（無法取得，請略過講義範圍檢查）`;

  const userPrompt = `## 新題目
檔案: ${basename}
主題: ${pillar} / ${concept}

\`\`\`yaml
${newContent}\`\`\`

${conceptSection}

${handoutSection}

## 本主題的既有題目（共 ${existingFiles.length} 題）
${existingSection}

## 審查任務

學生根據課程講義自行設計題目。請幫助他們確保題目的技術正確性。

### 1. 正確性驗證（最重要）

請對每個選項進行以下結構化分析，將分析過程寫入 option_analysis 欄位：

**對每個選項（A/B/C/D），回答：**
1. 這個選項的核心主張是什麼？
2. 在題幹描述的情境下，這個主張是否成立？
3. 如果是錯誤選項：它的 explanation 說它錯的理由是否正確？有沒有哪句斷言是事實上錯誤的？
4. 如果是錯誤選項：在題幹的同一情境下，這個選項有沒有可能也是對的？

**判定標準：**
- 如果某個「錯誤」選項在題幹情境下也合理成立，破壞了單選性 → request-changes
- 如果 explanation 中有會誤導學生的事實錯誤（例如把一個可能發生的行為說成「不可能」）→ soundness_ok = false
- 合理的隱含假設不需要標記，小幅簡化也可以放過

### 2. 品質評估
- 題目是否在測試推理或應用能力？
- Explanation 是否有教育價值？

### 3. 重複偵測
- 這題的推理核心是否與既有題目不同？兩題即使情境不同，如果考的核心推理鏈相同，就算重複。
- 如果與既有題目重複，請指出是哪一題並說明重疊之處。

### 4. 範圍檢查
- 參考上方提供的主題頁面內容與講義內容，判斷這題是否在該主題的範圍內。
- 題目所考的知識點必須與主題頁面或講義中涵蓋的概念直接相關。
- 如果題目考的是其他主題的內容（即使相關），應標記為超出範圍並建議正確的主題。
- 如果主題頁面或講義無法取得，請略過此項檢查。

**不要檢查格式、標點或排版。只看內容是否正確且嚴謹。**

請以下列 JSON 格式回覆（feedback 和 explanation 請用繁體中文寫，技術名詞維持英文）：
{
  "option_analysis": [
    "選項 A：（核心主張）...（在題幹情境下是否成立）...（explanation 是否有事實錯誤）...",
    "選項 B：...",
    "選項 C：...",
    "選項 D：..."
  ],
  "quality_verdict": "approve" | "request-changes",
  "quality_feedback": "一段話說明你的評估。",
  "correctness_ok": true | false,
  "correctness_issue": "如有正確性問題，說明哪裡有誤或有歧義" | null,
  "soundness_ok": true | false,
  "soundness_issue": "如有嚴謹度問題，說明哪個選項的 explanation 有事實錯誤或哪個假設未交代" | null,
  "is_duplicate": true | false,
  "duplicate_of": "filename.yaml" | null,
  "duplicate_explanation": "..." | null,
  "in_scope": true | false,
  "scope_issue": "如果超出範圍，說明為何不屬於此主題，並建議應歸屬哪個主題" | null,
  "student_message": "如果需要修改，寫一段簡短友善的訊息給同學，說明需要修正什麼。如果可以合併，設為 null。" | null,
  "suggestions": ["2-3 個替代出題方向，供同學在題目重複或需改進時參考"]
}`;

  const systemPrompt = `你是一位研究所等級 storage systems 課程的 quiz 審查員。學生根據課程講義設計題目，你負責幫助他們確保題目的技術正確性。

你的審查原則：
- 鼓勵學生的努力，肯定設計良好的部分。
- 只標記真正的技術錯誤或會讓答題者困惑的歧義，不要挑剔細節或邊緣情境。
- 如果正確答案確實有誤、或某個錯誤選項在題幹描述的情境下同樣成立（破壞單選性），才標記為 request-changes。
- explanation 中的事實錯誤要指出，但用語上的小瑕疵可以忽略。
- 給同學的回饋要友善、具建設性，讓他們知道怎麼改就好。

不要檢查格式或標點。請用繁體中文回覆，技術名詞維持英文。`;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-opus-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 120000)),
    ]);

    let text = response.content[0].text;

    // Strip markdown code fences if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) text = jsonMatch[1];

    const review = JSON.parse(text.trim());
    return { file: basename, relPath, review, error: null, content: newContent };
  } catch (err) {
    console.error(`  API 錯誤 (${basename}): ${err.message}`);
    return { file: basename, relPath, review: null, error: err.message, content: newContent };
  }
}

// Regex-based format checking (replaces LLM-based format check)
function checkFormatting(yamlContent) {
  const issues = [];

  // Extract all text fields from YAML content
  const lines = yamlContent.split('\n');
  const textLines = lines.filter(l => !l.match(/^\s*(author|date|correct):/));

  const fullText = textLines.join('\n');

  // Check: Chinese-English/number spacing
  // Only flag CJK hanzi directly adjacent to ASCII letter/digit (no space between).
  // CJK punctuation (，。：；「」（）etc.) next to ASCII is OK — no space needed.
  const cjkNoSpaceBefore = /[\u4e00-\u9fff\u3400-\u4dbf]([a-zA-Z0-9])/g;
  const cjkNoSpaceAfter = /([a-zA-Z0-9])[\u4e00-\u9fff\u3400-\u4dbf]/g;

  let match;
  const spacingViolations = new Set();
  while ((match = cjkNoSpaceBefore.exec(fullText)) !== null) {
    const ctx = fullText.slice(Math.max(0, match.index - 3), match.index + match[0].length + 3);
    spacingViolations.add(ctx.trim());
  }
  while ((match = cjkNoSpaceAfter.exec(fullText)) !== null) {
    const ctx = fullText.slice(Math.max(0, match.index - 3), match.index + match[0].length + 3);
    spacingViolations.add(ctx.trim());
  }
  if (spacingViolations.size > 0) {
    const examples = [...spacingViolations].slice(0, 5).map(s => `「${s}」`).join('、');
    issues.push(`中英文/數字之間缺少空白: ${examples}`);
  }

  // Check: em dash usage
  if (fullText.includes('—')) {
    issues.push('使用了 em dash（—），請改用逗號或分號');
  }

  return issues;
}

async function main() {
  const results = [];
  for (const f of files) {
    console.log(`審查中: ${f}`);
    const result = await reviewFile(f);
    results.push(result);
  }

  // Format markdown
  const mdParts = ['## \uD83E\uDD16 AI 題目審查\n'];

  for (const r of results) {
    mdParts.push(`### \`${r.relPath}\`\n`);

    if (r.error) {
      mdParts.push(`> 此檔案的 AI 審查不可用: ${r.error}，請人工審查。\n`);
      continue;
    }

    const rv = r.review;

    // Correctness check
    const correctIcon = rv.correctness_ok ? '\u2705 正確無誤' : '\u274C 正確性有問題';
    mdParts.push(`**正確性驗證:** ${correctIcon}`);
    if (!rv.correctness_ok && rv.correctness_issue) {
      mdParts.push(`> ${rv.correctness_issue}\n`);
    } else {
      mdParts.push('');
    }

    // Soundness
    const soundIcon = (rv.soundness_ok === false) ? '\u274C 嚴謹度有問題' : '\u2705 通過';
    mdParts.push(`**技術嚴謹度:** ${soundIcon}`);
    if (rv.soundness_ok === false && rv.soundness_issue) {
      mdParts.push(`> ${rv.soundness_issue}\n`);
    } else {
      mdParts.push('');
    }

    // Quality
    const qualityIcon = rv.quality_verdict === 'approve' ? '\u2705 通過' : '\u26A0\uFE0F 建議修改';
    mdParts.push(`**品質評估:** ${qualityIcon}`);
    mdParts.push(`> ${rv.quality_feedback}\n`);

    // Duplicate
    const dupIcon = rv.is_duplicate ? '\u274C 偵測到重複' : '\u2705 無重複';
    mdParts.push(`**重複偵測:** ${dupIcon}`);
    if (rv.is_duplicate && rv.duplicate_explanation) {
      mdParts.push(`> 此題與 \`${rv.duplicate_of}\` 重疊。${rv.duplicate_explanation}\n`);
    } else if (!rv.is_duplicate) {
      mdParts.push('> 與本主題的既有題目無重疊。\n');
    }

    // Scope
    if (rv.in_scope === false) {
      mdParts.push('**範圍檢查:** \u274C 超出主題範圍');
      if (rv.scope_issue) {
        mdParts.push(`> ${rv.scope_issue}\n`);
      }
    } else if (rv.in_scope === true) {
      mdParts.push('**範圍檢查:** \u2705 在主題範圍內\n');
    } else {
      mdParts.push('**範圍檢查:** \u2796 無法判斷（主題頁面不可用）\n');
    }

    // Format check (regex-based, not LLM)
    const fmtIssues = r.content ? checkFormatting(r.content) : [];
    if (fmtIssues.length > 0) {
      mdParts.push('**格式規範:** \u274C 有格式問題');
      for (const issue of fmtIssues) {
        mdParts.push(`> - ${issue}`);
      }
      mdParts.push('');
    } else {
      mdParts.push('**格式規範:** \u2705 符合規範\n');
    }

    // Student message
    if (rv.student_message && rv.quality_verdict !== 'approve') {
      mdParts.push('**給同學的訊息:**');
      mdParts.push(`> ${rv.student_message}\n`);
    }

    if (rv.suggestions && rv.suggestions.length > 0 && (rv.is_duplicate || rv.quality_verdict !== 'approve' || !rv.correctness_ok || rv.soundness_ok === false)) {
      mdParts.push('**替代出題方向建議:**');
      for (let i = 0; i < rv.suggestions.length; i++) {
        mdParts.push(`${i + 1}. ${rv.suggestions[i]}`);
      }
      mdParts.push('');
    }

    mdParts.push('---\n');
  }

  mdParts.push('_審查由 Claude (claude-opus-4-20250514) 執行。此為建議性質，最終由助教或老師決定是否 merge。_\n');

  const markdown = mdParts.join('\n');
  console.log('\n' + markdown);
  fs.writeFileSync(path.join(repoRoot, 'claude-review-results.md'), markdown);
  console.log('結果已寫入 claude-review-results.md');
}

main();
