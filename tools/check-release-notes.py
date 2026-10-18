#!/usr/bin/env python3
# 检查 CHANGELOG 里某一版的发版说明是否合规（规则见 AGENTS.md「发版说明」）。
# 用法：python3 tools/check-release-notes.py <版本号> [CHANGELOG.md]
# 不合规时逐条列出问题并以 1 退出；CI（.github/workflows/release.yml）发版前会跑它，不过就不发布。
import re
import sys

MIN_ITEMS, MAX_ITEMS, MAX_CHARS = 3, 6, 90

# 「怎么实现」的痕迹：这些内容进 HANDOFF 的「本版技术记录」或 commit message，不进发版说明
IMPLEMENTATION = [
    (re.compile(r'`'), '代码格式（反引号）'),
    (re.compile(r'\b[\w.-]+\.(js|mjs|css|html|json|md|yml|yaml|ps1|py|sh)\b', re.I), '文件名'),
    (re.compile(r'重构|自检|单测|单元测试|回归测试|测试用例|流水线|HANDOFF|函数|纯函数'), '内部实现 / 测试用语'),
    (re.compile(r'\bCI\b|\bcommit\b|\brefactor\b', re.I), '内部实现 / 测试用语'),
]
# 一句话：句中不能再出现句末标点（结尾的一个可以）
SENTENCE_END = re.compile(r'[。！？；!?;]')


def section(text, version):
    lines = text.splitlines()
    out, found = [], False
    for line in lines:
        if not found:
            if line.startswith('## ' + version + ' ') or line.strip() == '## ' + version:
                found = True
            continue
        if line.startswith('## '):
            break
        out.append(line)
    return out if found else None


def check(version, path):
    text = open(path, encoding='utf-8').read()
    lines = section(text, version)
    if lines is None:
        return ['CHANGELOG 里没有「## %s — 标题」这一节' % version]
    problems, items = [], []
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        if line[:1].isspace():
            problems.append('第 %d 行：不许有子项或缩进内容：%s' % (n, line.strip()))
            continue
        if not line.startswith('- '):
            problems.append('第 %d 行：只能写「- 」开头的条目，不要写段落 / 标题：%s' % (n, line))
            continue
        items.append(line[2:].strip())
    if not MIN_ITEMS <= len(items) <= MAX_ITEMS:
        problems.append('条目数 %d：每版要 %d–%d 条' % (len(items), MIN_ITEMS, MAX_ITEMS))
    for i, item in enumerate(items, 1):
        if len(item) > MAX_CHARS:
            problems.append('第 %d 条 %d 字，超过 %d 字：%s' % (i, len(item), MAX_CHARS, item))
        if SENTENCE_END.search(item[:-1]):
            problems.append('第 %d 条不止一句话（句中有句末标点）：%s' % (i, item))
        for pattern, why in IMPLEMENTATION:
            if pattern.search(item):
                problems.append('第 %d 条写了%s，这类内容进 HANDOFF「本版技术记录」或 commit message：%s' % (i, why, item))
                break
    return problems


def main():
    if len(sys.argv) < 2:
        print(__doc__ or '用法：python3 tools/check-release-notes.py <版本号> [CHANGELOG.md]')
        return 2
    version = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) > 2 else 'CHANGELOG.md'
    problems = check(version, path)
    if problems:
        print('%s 的发版说明不合规（规则见 AGENTS.md「发版说明」）：' % version)
        for p in problems:
            print('  - ' + p)
        return 1
    print('%s 的发版说明合规' % version)
    return 0


if __name__ == '__main__':
    sys.exit(main())
