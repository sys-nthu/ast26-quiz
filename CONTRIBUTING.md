# Contributing Quiz Questions

## Quick Start

1. Fork this repository
2. Copy `templates/quiz-template.yaml`
3. Place your copy in the right topic folder:
   `docs/<pillar>/<concept>/quiz/q-<your-github-username>-1.yaml`
4. Write your question following the template
5. Open a Pull Request

See `CONCEPTS.md` for the full list of available topics.

## Writing Good Questions

**DO:**
- Test reasoning and application, not vocabulary recall
- Make distractors plausible (each should represent a real misconception)
- Make the correct answer unambiguously correct
- Use Markdown formatting: **bold**, `inline code`, $math$
- Write clear explanations for ALL four options

**DON'T:**
- Write "which of the following is true" style questions
- Make one option obviously wrong or joke-like
- Copy questions from textbooks or other sources
- Submit questions on topics you haven't studied yet

## 格式規範

1. **中英文之間加空白：** 中文與英文（或數字）之間必須有一個半形空白。
   - 正確：`每個 page 大小為 4KB`
   - 錯誤：`每個page大小為4KB`
2. **標點符號：** 純英文題目使用英文半形標點 `,.:`；繁體中文題目使用全形標點 `，。：`。
3. **禁止使用 em dash（—）：** 如需連接語句，請用逗號或分號。

## Example

See `templates/quiz-template.yaml` for a complete example.

## What Happens After You Submit

1. Automated checks validate your YAML structure
2. An AI reviewer checks question quality and uniqueness
3. A maintainer reviews and merges your PR
4. Your question appears on the course website with your name as author

## File Naming

Your file must be named: `q-<your-github-username>-<number>.yaml`

- Use your actual GitHub username (the one on the PR)
- Number sequentially: `-1`, `-2`, `-3` for multiple questions in the same topic
- Example: `q-alice-chen-1.yaml`, `q-alice-chen-2.yaml`

## Troubleshooting

**CI says "author mismatch":**
The `author:` field in your YAML must match your GitHub username exactly.

**CI says "invalid folder":**
Check `CONCEPTS.md` for valid topic paths. Make sure your file is inside a `quiz/` folder.

**AI reviewer says "duplicate":**
Your question overlaps with an existing one. Read the reviewer's suggestion for
alternative angles to explore.
