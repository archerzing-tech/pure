// 编码 Agent 测试集（简单 + 复杂）S/M 部分的 fixture：~/Documents/编码 Agent 测试集（简单 + 复杂）.md
//
// 落库原则（与用户「工具/skill 与 pure 实际支持对齐」的要求一致）：
//  1) prompt 逐字取自测试集「输入」；
//  2) 交付物的确定性契约（文件路径、CLI 用法、输出格式）写进种子 README/docs，
//     不让 prompt 承担工程约定——否则验收只能靠猜，测的就不是模型而是猜谜；
//  3) 测试集「自动验收」→ verification（决定 pass/fail）；
//     测试集「陷阱 / 反例检测」→ boundaryChecks / sourceAudits / answerAudits
//     （独立记录，不回写 pass/fail，避免把风格问题混进正确性）；
//  4) 每个 fixture 都带金标准解：sanity 阶段要求「控制组从种子失败、金标准解通过」，
//     否则 fixture 本身有问题，任何 provider 结果都不该被采信。
//
// 内容一律用 String.raw：嵌入的 Python/TS 里有 \t \d \n 等转义，
// 普通模板字符串会先被 TS 吃掉，把测试源码写坏。

export interface TestSetVerification {
  name: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}

/** 隐藏边界检查：测试集「陷阱」的可执行形态。在 workspace 之外生成，运行后单独复核。 */
export interface TestSetBoundaryCheck {
  name: string;
  file: string;
  content: string;
  args?: string[];
  note: string;
}

export interface TestSetFixture {
  id: string;
  section: 'S' | 'M' | 'L';
  title: string;
  category: 'bugfix' | 'feature' | 'refactor' | 'multi-step' | 'recovery' | 'guardrail' | 'long-context' | 'repo-scale' | 'performance';
  difficulty: 'easy' | 'medium' | 'hard' | 'extreme';
  /** 测试集「输入」原文。 */
  prompt: string;
  files: Record<string, string>;
  verification: TestSetVerification[];
  /** 验收脚本：写到 workspace 之外，验收命令里用 {{checks}}/<file> 引用。 */
  verificationScripts?: TestSetBoundaryCheck[];
  boundaryChecks?: TestSetBoundaryCheck[];
  sourceAudits?: { label: string; file: string; mustNotMatch?: string; mustMatch?: string; note: string }[];
  answerAudits?: { label: string; pattern: string; note: string }[];
  inventoryAudits?: { label: string; mustBeAbsent: string[]; note: string }[];
  /** 轨迹顺序审计：firstPattern 必须出现在 thenPattern 首次出现之前。 */
  orderAudit?: { label: string; firstPattern: string; thenPattern: string; note: string };
  /** 运行后必须与种子逐字节一致的文件（proq 注入 / 验收口径文件）。 */
  unchangedFiles?: string[];
  /** 测试集假设的工具/skill ↔ pure 实际资源的对齐说明。 */
  alignment: string[];
  /** 与测试集的偏离（环境缺失时的降级），必须显式记录。 */
  adaptation?: string;
  budget?: { maxTurns?: number };
  golden: Record<string, string>;
}

const PYPROJECT = String.raw`[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
`;

export const TEST_SET_TASKS_SM: TestSetFixture[] = [
  // ── S01 ────────────────────────────────────────────────────────────────────
  {
    id: 'S01',
    section: 'S',
    title: '罗马数字转整数',
    category: 'feature',
    difficulty: 'easy',
    prompt: '写一个函数 roman_to_int(s)，输入合法罗马数字，返回整数。',
    files: {
      'README.md': String.raw`# roman

python roman_to_int(s) 放在 \`roman.py\`，测试在 \`tests/\`。

\`\`\`bash
pytest -q
\`\`\`
`,
      'roman.py': String.raw`def roman_to_int(s: str) -> int:
    """把罗马数字转成整数。"""
    raise NotImplementedError
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_roman.py': String.raw`from roman import roman_to_int


def test_plain_and_subtractive():
    assert roman_to_int("III") == 3
    assert roman_to_int("IV") == 4
    assert roman_to_int("IX") == 9


def test_long_forms():
    assert roman_to_int("LVIII") == 58
    assert roman_to_int("MCMXCIV") == 1994
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '空输入要有处理',
        file: 's01_empty.py',
        note: '测试集：没有空输入处理 -5；期望行为是抛 ValueError（测试集给出的参考答案）',
        content: String.raw`import sys

import roman


def main() -> int:
    try:
        value = roman.roman_to_int("")
    except ValueError as error:
        print("ok: raises ValueError for empty input:" + type(error).__name__)
        return 0
    except Exception as error:  # noqa: BLE001 - 记录实际行为
        print("partial: raises " + type(error).__name__ + " instead of ValueError")
        return 1
    print("missing: empty input returned " + repr(value))
    return 1


if __name__ == "__main__":
    sys.exit(main())
`,
      },
    ],
    alignment: [
      '测试集「一个函数 + 边界测试」→ pure 工具：write_file/edit_file 改 roman.py + execute_command 跑验收',
      '验收命令 pytest → 回放环境按 PATH shim 提供（测试集假设的解释器/测试器属于环境，不是 pure 工具）',
    ],
    golden: {
      'roman.py': String.raw`VALUES = {
    "I": 1,
    "V": 5,
    "X": 10,
    "L": 50,
    "C": 100,
    "D": 500,
    "M": 1000,
}


def roman_to_int(s: str) -> int:
    if not s:
        raise ValueError("empty roman numeral")
    total = 0
    previous = 0
    for char in reversed(s):
        value = VALUES.get(char)
        if value is None:
            raise ValueError("invalid roman numeral: " + s)
        if value < previous:
            total -= value
        else:
            total += value
            previous = value
    return total
`,
    },
  },

  // ── S02 ────────────────────────────────────────────────────────────────────
  {
    id: 'S02',
    section: 'S',
    title: 'FizzBuzz 变体',
    category: 'feature',
    difficulty: 'easy',
    prompt: '打印 1-100，3 的倍数输出 Fizz，5 的倍数输出 Buzz，7 的倍数输出 Jazz，同时满足按 FizzBuzzJazz 顺序拼接。',
    files: {
      'README.md': String.raw`# fizzbuzz

\`fizzbuzz.py\` 提供 \`fizzbuzz(n)\`，直接运行时打印 1-100。

\`\`\`bash
python fizzbuzz.py
pytest -q
\`\`\`
`,
      'fizzbuzz.py': String.raw`def fizzbuzz(n: int) -> str:
    raise NotImplementedError


if __name__ == "__main__":
    for value in range(1, 101):
        print(fizzbuzz(value))
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_fizzbuzz.py': String.raw`import subprocess
import sys

from fizzbuzz import fizzbuzz


def test_combinations():
    assert fizzbuzz(15) == "FizzBuzz"
    assert fizzbuzz(21) == "FizzJazz"
    assert fizzbuzz(105) == "FizzBuzzJazz"


def test_plain_numbers():
    assert fizzbuzz(1) == "1"
    assert fizzbuzz(2) == "2"


def test_main_prints_one_hundred_lines():
    result = subprocess.run([sys.executable, "fizzbuzz.py"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    lines = result.stdout.strip().splitlines()
    assert len(lines) == 100
    assert lines[0] == "1"
    assert lines[14] == "FizzBuzz"
    assert lines[20] == "FizzJazz"
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '5 与 7 同时满足时的拼接顺序',
        file: 's02_order.py',
        note: '测试集陷阱：3→5→7 顺序拼接；35 必须是 BuzzJazz 而不是 JazzBuzz',
        content: String.raw`import sys

from fizzbuzz import fizzbuzz


def main() -> int:
    cases = {35: "BuzzJazz", 70: "BuzzJazz", 3: "Fizz", 5: "Buzz", 7: "Jazz"}
    failures = []
    for value, expected in cases.items():
        actual = fizzbuzz(value)
        if actual != expected:
            failures.append(str(value) + ": expected " + expected + ", got " + actual)
    if failures:
        print("order mismatch: " + "; ".join(failures))
        return 1
    print("order ok: 3->5->7 concatenation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`,
      },
    ],
    alignment: [
      '测试集默认「按 3→5→7 顺序拼」→ 不要求澄清即可推断，回放不放宽：直接按该顺序验收',
      '纯文字打印任务 → verify 用 execute_command 跑 python + 捕获 stdout（pure 无专用测试工具）',
    ],
    golden: {
      'fizzbuzz.py': String.raw`def fizzbuzz(n: int) -> str:
    label = ""
    if n % 3 == 0:
        label += "Fizz"
    if n % 5 == 0:
        label += "Buzz"
    if n % 7 == 0:
        label += "Jazz"
    return label or str(n)


if __name__ == "__main__":
    for value in range(1, 101):
        print(fizzbuzz(value))
`,
    },
  },

  // ── S03 ────────────────────────────────────────────────────────────────────
  {
    id: 'S03',
    section: 'S',
    title: 'Bug 修复：差一错误',
    category: 'bugfix',
    difficulty: 'easy',
    prompt: 'def last_n(items, n): return items[len(items)-n: len(items)-n+1] —— 这个函数应该返回最后 n 个，实际只返回 1 个。',
    files: {
      'src/__init__.py': '',
      'src/last_n.py': String.raw`def last_n(items: list, n: int) -> list:
    return items[len(items) - n: len(items) - n + 1]
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_last_n.py': String.raw`from src.last_n import last_n


def test_returns_the_last_n_items():
    assert last_n([1, 2, 3, 4], 2) == [3, 4]
    assert last_n([1, 2, 3, 4, 5], 3) == [3, 4, 5]


def test_zero_returns_nothing():
    assert last_n([1, 2, 3], 0) == []
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: 'n 大于长度时的行为',
        file: 's03_oversize.py',
        note: '测试集只给了 n=0 的边界；n>len 也要不炸（返回全部）',
        content: String.raw`import sys

from src.last_n import last_n


def main() -> int:
    assert last_n([1, 2], 0) == []
    assert last_n([], 0) == []
    assert last_n([], 3) == []
    assert last_n([1, 2, 3], 3) == [1, 2, 3]
    assert last_n([1, 2, 3], 9) == [1, 2, 3]
    print("oversize/empty ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`,
      },
    ],
    inventoryAudits: [
      {
        label: '反例：重写整个模块（-20）',
        mustBeAbsent: [],
        note: '用运行后的文件清单与 src/last_n.py 行数复核（脚本侧统计，不进 pass/fail）',
      },
    ],
    alignment: [
      '测试集「一行修成 items[-n:]」→ pure：edit_file 最小改动，无需重构',
      '反例「重写整个模块」→ 用运行后文件清单 + 目标文件行数人工/脚本复核',
    ],
    golden: {
      'src/last_n.py': String.raw`def last_n(items: list, n: int) -> list:
    if n <= 0:
        return []
    return items[-n:]
`,
    },
  },

  // ── S04 ────────────────────────────────────────────────────────────────────
  {
    id: 'S04',
    section: 'S',
    title: '单文件 CSV 统计 CLI',
    category: 'feature',
    difficulty: 'easy',
    prompt: '一个脚本，读 CSV，输出每列的非空数量、唯一值数、数值列的均值。',
    files: {
      'README.md': String.raw`# csv-stats

\`\`\`bash
python stats_csv.py data/sample.csv
\`\`\`

输出：每个表头一行，按 CSV 列顺序，格式固定为

\`\`\`
<列名> non-empty=<非空值数量> unique=<去重后的值数量> mean=<均值，两位小数>
\`\`\`

- 该列所有非空值都能解析为数字时，才追加 \`mean=\`；
- 平均值保留两位小数（\`round(mean, 2)\`，固定两位）。
`,
      'stats_csv.py': String.raw`def column_stats(header: list, rows: list) -> list:
    raise NotImplementedError


def main(path: str) -> None:
    raise NotImplementedError


if __name__ == "__main__":
    import sys

    main(sys.argv[1])
`,
      'data/sample.csv': String.raw`name,age,score,city
ada,36,90.5,Xi'an
bob,,70,Beijing
curie,40,,Xi'an
,31,80.25,
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_stats_csv.py': String.raw`import re
import subprocess
import sys

from pathlib import Path

LINE = re.compile(r"^(\S+) non-empty=(\d+) unique=(\d+)(?: mean=([\d.]+))?$")


def run() -> dict:
    result = subprocess.run(
        [sys.executable, "stats_csv.py", str(Path("data") / "sample.csv")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    parsed = {}
    for line in result.stdout.splitlines():
        match = LINE.match(line.strip())
        assert match, "unexpected output line: " + repr(line)
        name, non_empty, unique, mean = match.groups()
        parsed[name] = (int(non_empty), int(unique), mean)
    return parsed


def test_counts_and_means():
    parsed = run()
    assert parsed["name"] == (3, 3, None)
    assert parsed["age"] == (3, 3, "35.67")
    assert parsed["score"] == (3, 3, "80.25")
    assert parsed["city"] == (3, 2, None)
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '非数值列不得出现 mean',
        file: 's04_string_column.py',
        note: '测试集反例：未处理非数值列 -10',
        content: String.raw`import subprocess
import sys

result = subprocess.run([sys.executable, "stats_csv.py", "data/sample.csv"], capture_output=True, text=True)
if result.returncode != 0:
    print("script failed: " + result.stderr.strip()[:200])
    sys.exit(1)
string_lines = [line for line in result.stdout.splitlines() if line.startswith("city")]
if not string_lines or "mean=" in string_lines[0]:
    print("string column got a mean: " + repr(string_lines))
    sys.exit(1)
print("ok: string column reports counts only")
`,
      },
    ],
    inventoryAudits: [
      {
        label: '反例：拆成 5 个文件（-15）',
        mustBeAbsent: [],
        note: '运行后统计新增文件数；测试集期望单文件实现',
      },
    ],
    alignment: [
      '测试集「单文件 + 用法示例」→ pure：write_file 写一个脚本 + execute_command 跑样例',
      '输出格式由种子 README 固定（prompt 只说「输出…」，格式不定就无法自动验收）',
    ],
    golden: {
      'stats_csv.py': String.raw`import csv
import sys


def parse_number(value: str):
    try:
        return float(value)
    except ValueError:
        return None


def column_stats(header: list, rows: list) -> list:
    result = []
    for index, name in enumerate(header):
        values = [row[index] for row in rows if index < len(row) and row[index] != ""]
        numbers = [parse_number(value) for value in values]
        numeric = bool(values) and all(number is not None for number in numbers)
        entry = {
            "name": name,
            "non_empty": len(values),
            "unique": len(set(values)),
            "mean": round(sum(numbers) / len(numbers), 2) if numeric else None,
        }
        result.append(entry)
    return result


def format_stat(entry: dict) -> str:
    line = entry["name"] + " non-empty=" + str(entry["non_empty"]) + " unique=" + str(entry["unique"])
    if entry["mean"] is not None:
        line += " mean=" + format(entry["mean"], ".2f")
    return line


def main(path: str) -> None:
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        rows = [row for row in reader]
    for entry in column_stats(header, rows):
        print(format_stat(entry))


if __name__ == "__main__":
    main(sys.argv[1])
`,
    },
  },

  // ── S05 ────────────────────────────────────────────────────────────────────
  {
    id: 'S05',
    section: 'S',
    title: '日期格式化工具',
    category: 'feature',
    difficulty: 'easy',
    prompt: '函数 fmt_date(dt, style)，支持 "iso"、"us"、"eu" 三种。',
    files: {
      'README.md': String.raw`# fmt_date

\`src/fmt_date.py\` 的 \`fmt_date(dt, style)\` 输出固定为

| style | 样例（2026-03-04 05:06:07 UTC） |
| --- | --- |
| \`iso\` | \`2026-03-04T05:06:07+00:00\` |
| \`us\` | \`03/04/2026 05:06:07\` |
| \`eu\` | \`04/03/2026 05:06:07\` |

- \`dt\` 不带 tzinfo 时按 UTC 处理；
- 带 tzinfo 时先换算成 UTC 再格式化；
- 未知 style 抛 \`ValueError\`。
`,
      'src/__init__.py': '',
      'src/fmt_date.py': String.raw`def fmt_date(dt, style: str) -> str:
    raise NotImplementedError
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_fmt_date.py': String.raw`from datetime import datetime, timedelta, timezone

import pytest

from src.fmt_date import fmt_date


def test_iso():
    assert fmt_date(datetime(2026, 3, 4, 5, 6, 7), "iso") == "2026-03-04T05:06:07+00:00"


def test_us_and_eu():
    assert fmt_date(datetime(2026, 3, 4, 5, 6, 7), "us") == "03/04/2026 05:06:07"
    assert fmt_date(datetime(2026, 3, 4, 5, 6, 7), "eu") == "04/03/2026 05:06:07"


def test_aware_input_is_converted_to_utc():
    dt = datetime(2026, 3, 4, 5, 6, 7, tzinfo=timezone(timedelta(hours=8)))
    assert fmt_date(dt, "iso") == "2026-03-03T21:06:07+00:00"


def test_unknown_style_raises():
    with pytest.raises(ValueError):
        fmt_date(datetime(2026, 3, 4), "nope")
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: 'US/EU 时区换算',
        file: 's05_tz.py',
        note: '测试集陷阱：时区未指定 → 默认 UTC；带 tzinfo 的输入三种 style 都要正确',
        content: String.raw`import sys
from datetime import datetime, timedelta, timezone

from src.fmt_date import fmt_date

dt = datetime(2026, 12, 31, 23, 30, 0, tzinfo=timezone(timedelta(hours=-5)))
cases = {
    "iso": "2027-01-01T04:30:00+00:00",
    "us": "01/01/2027 04:30:00",
    "eu": "01/01/2027 04:30:00",
}
for style, expected in cases.items():
    actual = fmt_date(dt, style)
    if actual != expected:
        print(style + ": expected " + expected + ", got " + actual)
        sys.exit(1)
print("tz conversion ok")
`,
      },
    ],
    sourceAudits: [
      {
        label: '反例：引入 pendulum/arrow（-10）',
        file: 'src/fmt_date.py',
        mustNotMatch: 'import (pendulum|arrow)',
        note: '测试集要求用标准库',
      },
    ],
    alignment: [
      '测试集「标准库够用」→ pure 环境无第三方日期库，写依赖会直接跑不起来（与反例检测同向）',
      'prompt 只说三种 style，具体格式由种子 README 固定（否则 us/eu 无法自动验收）',
    ],
    golden: {
      'src/fmt_date.py': String.raw`from datetime import timezone


def fmt_date(dt, style: str) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    if style == "iso":
        return dt.isoformat()
    if style == "us":
        return dt.strftime("%m/%d/%Y %H:%M:%S")
    if style == "eu":
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    raise ValueError("unknown style: " + str(style))
`,
    },
  },

  // ── S06 ────────────────────────────────────────────────────────────────────
  {
    id: 'S06',
    section: 'S',
    title: '正则提取邮箱',
    category: 'feature',
    difficulty: 'easy',
    prompt: '从文本提取所有邮箱，去重，排序。',
    files: {
      'README.md': String.raw`# emails

\`emails.py\` 暴露 \`extract_emails(text) -> list[str]\`：提取全部邮箱地址、去重、按字典序升序返回。

只认「local@domain.tld」形态（域必须有至少一个点，TLD 至少两位）。
`,
      'emails.py': String.raw`def extract_emails(text: str) -> list[str]:
    raise NotImplementedError
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_emails.py': String.raw`from emails import extract_emails

SAMPLE = (
    "联系 a@b.com 或 a+b@c.co.uk；重复 a@b.com；"
    "写成 <admin@example.com>。无效：invalid@ 、@@x.com、a@b"
)


def test_extracts_dedupes_and_sorts():
    expected = ["a+b@c.co.uk", "a@b.com", "admin@example.com"]
    assert extract_emails(SAMPLE) == sorted(expected)


def test_no_match_returns_empty_list():
    assert extract_emails("这里没有邮箱") == []
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '反例正则 .*@.* 的典型误报',
        file: 's06_regex.py',
        note: '测试集反例：用了 .*@.* 这种（-15）。not@an@email.com 曾在列，但其中的 an@email.com 是合法形态、金标准解也提取它，违反「金标准必过」，移除。',
        content: String.raw`import sys

from emails import extract_emails

bad_inputs = ["fail@", "@nouser.com", "a@b", "user@@host.com", "spaced @host.com"]
offenders = []
for text in bad_inputs:
    found = extract_emails(text)
    if found:
        offenders.append(repr(text) + " -> " + repr(found))
if offenders:
    print("false positives: " + "; ".join(offenders))
    sys.exit(1)

trailing = extract_emails("请在 (ops@team.io), 之前回复")
if trailing != ["ops@team.io"]:
    print("punctuation handling wrong: " + repr(trailing))
    sys.exit(1)
print("regex precision ok")
`,
      },
    ],
    alignment: [
      '测试集「用成熟正则 + 测试用例」→ pure：write_file + execute_command 跑 pytest',
      '无网络/无第三方依赖，验收完全离线',
    ],
    golden: {
      'emails.py': String.raw`import re

PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")


def extract_emails(text: str) -> list[str]:
    return sorted(set(PATTERN.findall(text)))
`,
    },
  },

  // ── S07 ────────────────────────────────────────────────────────────────────
  {
    id: 'S07',
    section: 'S',
    title: '简单 API 端点',
    category: 'feature',
    difficulty: 'easy',
    prompt: 'FastAPI 加一个 GET /health，返回 {"status":"ok","time":<iso>}。',
    files: {
      'README.md': String.raw`# health-demo

\`app/main.py\` 暴露 FastAPI 实例 \`app\`。

\`\`\`bash
uvicorn app.main:app --port 8000
pytest -q
\`\`\`
`,
      'app/__init__.py': '',
      'app/main.py': String.raw`from fastapi import FastAPI

app = FastAPI(title="health-demo")


@app.get("/ping")
def ping() -> dict:
    return {"pong": True}
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_health.py': String.raw`from datetime import datetime

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_payload():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    datetime.fromisoformat(body["time"])


def test_existing_route_still_works():
    assert client.get("/ping").json() == {"pong": True}
`,
    },
    verificationScripts: [
      {
        name: 'curl /health',
        file: 's07_curl.py',
        note: '测试集自动验收原文就是 curl /health 返回正确 JSON：真起 uvicorn 真探端口',
        content: String.raw`import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

PORT = 8737
URL = "http://127.0.0.1:" + str(PORT) + "/health"

server = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT), "--log-level", "warning"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
try:
    payload = None
    for _ in range(80):
        if server.poll() is not None:
            output = server.stdout.read().decode("utf-8", "replace")[:300]
            print("server exited before answering: " + output)
            sys.exit(1)
        try:
            with urllib.request.urlopen(URL, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except Exception:
            time.sleep(0.5)
    if payload is None:
        print("GET /health never answered")
        sys.exit(1)
    if payload.get("status") != "ok":
        print("bad payload: " + repr(payload))
        sys.exit(1)
    datetime.fromisoformat(payload["time"])
    print("curl ok: " + json.dumps(payload, ensure_ascii=False))
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
`,
      },
    ],
    verification: [
      { name: 'curl /health 真探活', command: 'python3', args: ['{{checks}}/s07_curl.py'], timeoutMs: 120_000 },
      { name: 'pytest', command: 'pytest', args: ['-q'] },
    ],
    inventoryAudits: [
      {
        label: '反例：建了 Docker/CI/多模块（-25）',
        mustBeAbsent: ['Dockerfile', 'docker-compose', '.github/', 'Makefile', 'tox.ini', 'setup.py'],
        note: '测试集期望「一个端点 + 一个测试，不建完整项目」',
      },
    ],
    alignment: [
      '测试集「curl /health 返回正确 JSON」→ pure 的 execute_command 起 uvicorn + curl 真探端口',
      'FastAPI/uvicorn/httpx 属于环境依赖，回放环境按需提供（不是 pure 工具缺口）',
    ],
    golden: {
      'app/main.py': String.raw`from datetime import datetime, timezone

from fastapi import FastAPI

app = FastAPI(title="health-demo")


@app.get("/ping")
def ping() -> dict:
    return {"pong": True}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}
`,
    },
  },

  // ── S08 ────────────────────────────────────────────────────────────────────
  {
    id: 'S08',
    section: 'S',
    title: '字符串压缩',
    category: 'feature',
    difficulty: 'easy',
    prompt: '实现 "aaabbc" → "a3b2c1"，空字符串返回空。',
    files: {
      'README.md': String.raw`# compress

\`src/compress.py\` 暴露 \`compress(s: str) -> str\`。

单字符也带计数字（\`"a"\` → \`"a1"\`），空字符串返回空字符串。
`,
      'src/__init__.py': '',
      'src/compress.py': String.raw`def compress(s: str) -> str:
    raise NotImplementedError
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_compress.py': String.raw`from src.compress import compress


def test_runs():
    assert compress("aaabbc") == "a3b2c1"


def test_empty():
    assert compress("") == ""
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '单字符/无重复/回环',
        file: 's08_edges.py',
        note: '测试集陷阱：单字符是否带 1 → 期望带 1',
        content: String.raw`import sys

from src.compress import compress

cases = {"a": "a1", "abc": "a1b1c1", "aabbaa": "a2b2a2", "aaaaaaaaaa": "a10"}
for value, expected in cases.items():
    actual = compress(value)
    if actual != expected:
        print(repr(value) + ": expected " + expected + ", got " + actual)
        sys.exit(1)
print("edge cases ok")
`,
      },
    ],
    alignment: [
      '测试集「默认带 1 + 一行说明」→ 验收只查行为；「是否一行说明」进人类表达评分',
    ],
    golden: {
      'src/compress.py': String.raw`def compress(s: str) -> str:
    if not s:
        return ""
    parts = []
    count = 1
    for index in range(1, len(s) + 1):
        if index < len(s) and s[index] == s[index - 1]:
            count += 1
        else:
            parts.append(s[index - 1] + str(count))
            count = 1
    return "".join(parts)
`,
    },
  },

  // ── M01 ────────────────────────────────────────────────────────────────────
  {
    id: 'M01',
    section: 'M',
    title: 'CLI 待办工具',
    category: 'feature',
    difficulty: 'medium',
    prompt: '命令行 todo，支持 add/list/done/rm，存 JSON 文件。',
    files: {
      'README.md': String.raw`# todo

\`\`\`bash
python todo.py add "买牛奶"
python todo.py list
python todo.py done 1
python todo.py rm 1
\`\`\`

契约：

- 存储文件默认 \`todo.json\`（当前工作目录），可用环境变量 \`TODO_FILE\` 覆盖；
- \`add <text>\` → stdout \`added <id>\`，id 从 1 起递增，不复用已删除的 id；
- \`list\` → 每行 \`<id>\t<done|todo>\t<text>\`，按 id 升序；空列表不输出任何行；
- \`done <id>\` → stdout \`done <id>\`；id 不存在 → stderr \`no such id: <id>\` 且退出码 1；
- \`rm <id>\` → stdout \`removed <id>\`；id 不存在同样报错退出 1；
- **多个进程同时 add 不能丢数据**（同一台机器并发写同一文件是常态）。
`,
      'todo.py': String.raw`import sys


def main(argv: list) -> int:
    raise NotImplementedError


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_todo.py': String.raw`import os
import subprocess
import sys
from pathlib import Path

TODO = Path.cwd() / "todo.py"


def env_for(tmp_path):
    env = dict(os.environ)
    env["TODO_FILE"] = str(tmp_path / "todo.json")
    return env


def run(env, *args):
    return subprocess.run([sys.executable, str(TODO), *args], capture_output=True, text=True, env=env)


def test_add_list_done_rm(tmp_path):
    env = env_for(tmp_path)
    assert run(env, "add", "买牛奶").stdout.strip() == "added 1"
    assert run(env, "add", "写周报").stdout.strip() == "added 2"
    assert run(env, "list").stdout.strip().splitlines() == ["1\ttodo\t买牛奶", "2\ttodo\t写周报"]
    assert run(env, "done", "1").stdout.strip() == "done 1"
    assert run(env, "list").stdout.strip().splitlines() == ["1\tdone\t买牛奶", "2\ttodo\t写周报"]
    assert run(env, "rm", "2").stdout.strip() == "removed 2"
    assert run(env, "list").stdout.strip().splitlines() == ["1\tdone\t买牛奶"]


def test_missing_id_exits_one(tmp_path):
    env = env_for(tmp_path)
    result = run(env, "done", "9")
    assert result.returncode == 1
    assert "9" in result.stderr
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '并发写不丢数据（否决项）',
        file: 'm01_concurrency.py',
        note: '测试集：并发写不丢数据；否决项=并发丢数据',
        content: String.raw`import concurrent.futures
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TODO = Path.cwd() / "todo.py"
tmp = Path(tempfile.mkdtemp(prefix="todo-concurrency-"))
env = dict(os.environ)
env["TODO_FILE"] = str(tmp / "todo.json")

COUNT = 12


def add(index: int) -> int:
    return subprocess.run(
        [sys.executable, str(TODO), "add", "task-" + str(index)],
        capture_output=True,
        text=True,
        env=env,
    ).returncode


with concurrent.futures.ThreadPoolExecutor(max_workers=COUNT) as pool:
    codes = list(pool.map(add, range(COUNT)))

if set(codes) != {0}:
    print("some concurrent adds failed: " + repr(codes))
    sys.exit(1)

listed = subprocess.run([sys.executable, str(TODO), "list"], capture_output=True, text=True, env=env)
rows = [line for line in listed.stdout.strip().splitlines() if line]
if len(rows) != COUNT:
    print("lost updates: " + str(len(rows)) + "/" + str(COUNT) + " landed")
    sys.exit(1)

ids = [row.split("\t")[0] for row in rows]
if len(set(ids)) != COUNT:
    print("duplicate ids after concurrent adds: " + repr(ids))
    sys.exit(1)
print("concurrent adds ok: " + str(len(rows)) + "/" + str(COUNT))
`,
      },
    ],
    alignment: [
      '测试集「argparse + 文件锁 + 测试」→ pure：write_file + execute_command（无专用锁工具，锁是代码里的事）',
      '并发验收用 12 个真进程同时写同一文件（不是线程内 mock），对得起「否决：并发丢数据」',
    ],
    golden: {
      'todo.py': String.raw`import fcntl
import json
import os
import sys


def store_path() -> str:
    return os.environ.get("TODO_FILE", "todo.json")


def read_state(handle) -> dict:
    handle.seek(0)
    raw = handle.read()
    if not raw.strip():
        return {"next_id": 1, "items": []}
    return json.loads(raw)


def write_state(handle, state: dict) -> None:
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps(state, ensure_ascii=False, indent=2))
    handle.flush()
    os.fsync(handle.fileno())


def mutate(change):
    path = store_path()
    with open(path, "a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            state = read_state(handle)
            result = change(state)
            write_state(handle, state)
            return result
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def main(argv: list) -> int:
    if not argv:
        print("usage: todo.py add|list|done|rm ...", file=sys.stderr)
        return 2
    command, rest = argv[0], argv[1:]
    if command == "add":
        text = rest[0] if rest else ""
        def change(state):
            item = {"id": state["next_id"], "text": text, "done": False}
            state["next_id"] += 1
            state["items"].append(item)
            return item["id"]
        item_id = mutate(change)
        print("added " + str(item_id))
        return 0
    if command == "list":
        state = {"next_id": 1, "items": []}
        path = store_path()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                state = read_state(handle)
        for item in state["items"]:
            flag = "done" if item["done"] else "todo"
            print(str(item["id"]) + "\t" + flag + "\t" + item["text"])
        return 0
    if command in ("done", "rm"):
        if not rest:
            print("missing id", file=sys.stderr)
            return 2
        target = int(rest[0])
        def change(state):
            for index, item in enumerate(state["items"]):
                if item["id"] == target:
                    if command == "done":
                        item["done"] = True
                    else:
                        state["items"].pop(index)
                    return True
            return False
        found = mutate(change)
        if not found:
            print("no such id: " + str(target), file=sys.stderr)
            return 1
        print(("done " if command == "done" else "removed ") + str(target))
        return 0
    print("unknown command: " + command, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
`,
    },
  },

  // ── M02 ────────────────────────────────────────────────────────────────────
  {
    id: 'M02',
    section: 'M',
    title: '从 OpenAPI 生成单个客户端类',
    category: 'feature',
    difficulty: 'medium',
    prompt: '根据 openapi.yaml 生成一个客户端类，覆盖里面的全部端点，分页要能迭代。',
    files: {
      'README.md': String.raw`# demo-client

\`openapi.yaml\` 是契约，\`client.py\` 实现一个客户端类。

\`\`\`python
from client import ApiClient

client = ApiClient("https://api.example.test", token="t")
client.list_users(page=1, limit=20)   # 原样返回 {"items": [...], "page": n, "next_page": n|None}
client.get_user("u1")
client.create_user({"name": "ada"})
client.list_orders(page=1)
client.get_order("o1")
for user in client.iter_users(limit=20):   # 跟随 next_page 直到 None，逐条 yield item
    ...
\`\`\`

- 用 \`httpx.Client\`，JSON 进 JSON 出；
- \`token\` 非空时带 \`Authorization: Bearer <token>\`；
- 非 2xx 抛 \`httpx.HTTPStatusError\`（不要让 httpx 自动 raise 之外再包一层）。
`,
      'openapi.yaml': String.raw`openapi: 3.0.3
info:
  title: Demo API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: listUsers
      parameters:
        - { name: page, in: query, schema: { type: integer, default: 1 } }
        - { name: limit, in: query, schema: { type: integer, default: 20 } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/User' } }
                  page: { type: integer }
                  next_page: { type: integer, nullable: true }
    post:
      operationId: createUser
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/User' }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
  /users/{userId}:
    get:
      operationId: getUser
      parameters:
        - { name: userId, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
  /orders:
    get:
      operationId: listOrders
      parameters:
        - { name: page, in: query, schema: { type: integer, default: 1 } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Order' } }
                  next_page: { type: integer, nullable: true }
  /orders/{orderId}:
    get:
      operationId: getOrder
      parameters:
        - { name: orderId, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
components:
  schemas:
    User:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
    Order:
      type: object
      properties:
        id: { type: string }
        total: { type: number }
`,
      'client.py': String.raw`class ApiClient:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        raise NotImplementedError
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_client.py': String.raw`import httpx
import pytest
import respx

from client import ApiClient

BASE = "https://api.example.test"


@respx.mock
def test_list_users_sends_paging_params_and_token():
    route = respx.get(f"{BASE}/users", params={"page": "1", "limit": "20"}).mock(
        return_value=httpx.Response(200, json={"items": [{"id": "u1"}], "page": 1, "next_page": None})
    )
    client = ApiClient(BASE, token="t")
    body = client.list_users()
    assert body == {"items": [{"id": "u1"}], "page": 1, "next_page": None}
    assert route.called
    assert route.calls[0].request.headers["authorization"] == "Bearer t"


@respx.mock
def test_iter_users_follows_next_page_until_none():
    first = respx.get(f"{BASE}/users", params={"limit": "20", "page": "1"}).mock(
        return_value=httpx.Response(200, json={"items": [{"id": "u1"}], "next_page": 2})
    )
    second = respx.get(f"{BASE}/users", params={"limit": "20", "page": "2"}).mock(
        return_value=httpx.Response(200, json={"items": [{"id": "u2"}], "next_page": None})
    )
    client = ApiClient(BASE)
    assert [user["id"] for user in client.iter_users()] == ["u1", "u2"]
    assert first.call_count == 1
    assert second.call_count == 1


@respx.mock
def test_single_resource_and_error():
    respx.get(f"{BASE}/orders/o1").mock(return_value=httpx.Response(200, json={"id": "o1", "total": 3.5}))
    respx.get(f"{BASE}/users/u9").mock(return_value=httpx.Response(404, json={"error": "not found"}))
    client = ApiClient(BASE)
    assert client.get_order("o1") == {"id": "o1", "total": 3.5}
    with pytest.raises(httpx.HTTPStatusError):
        client.get_user("u9")


@respx.mock
def test_create_user_returns_created_body():
    respx.post(f"{BASE}/users").mock(return_value=httpx.Response(201, json={"id": "u2", "name": "ada"}))
    client = ApiClient(BASE)
    assert client.create_user({"name": "ada"}) == {"id": "u2", "name": "ada"}
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '分页必须在 next_page 为 None 时停止',
        file: 'm02_pagination.py',
        note: '测试集陷阱：分页逻辑手写 → 迭代器不能死循环、不能漏页',
        content: String.raw`import sys

import httpx
import respx

from client import ApiClient

BASE = "https://api.example.test"


@respx.mock
def main() -> int:
    route = respx.get(f"{BASE}/users").mock(
        side_effect=[
            httpx.Response(200, json={"items": [{"id": "u1"}], "next_page": 2}),
            httpx.Response(200, json={"items": [{"id": "u2"}], "next_page": 3}),
            httpx.Response(200, json={"items": [{"id": "u3"}], "next_page": None}),
        ]
    )
    client = ApiClient(BASE)
    ids = [user["id"] for user in client.iter_users()]
    if ids != ["u1", "u2", "u3"]:
        print("pagination wrong: " + repr(ids))
        return 1
    if route.call_count != 3:
        print("expected 3 page requests, got " + str(route.call_count))
        return 1
    print("pagination ok: 3 pages, stopped on next_page=None")
    return 0


sys.exit(main())
`,
      },
    ],
    inventoryAudits: [
      {
        label: '反例：为 5 个端点建 5 个文件（-10）',
        mustBeAbsent: [],
        note: '统计运行后 app/client 相关新增文件数；测试集期望一个客户端类',
      },
    ],
    alignment: [
      '测试集「一个客户端类 + 分页迭代器 + mock 测试」→ pure：write_file + execute_command 跑 respx',
      'respx/httpx 是环境依赖（已按需提供）；pure 无「按 OpenAPI 生成」的专用工具，生成靠模型读 yaml',
    ],
    golden: {
      'client.py': String.raw`import httpx


class ApiClient:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        headers = {"Authorization": "Bearer " + token} if token else {}
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self._base_url, headers=headers)

    def _request(self, method: str, path: str, **kwargs):
        response = self._client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    def list_users(self, page: int = 1, limit: int = 20) -> dict:
        return self._request("GET", "/users", params={"page": page, "limit": limit})

    def create_user(self, payload: dict) -> dict:
        return self._request("POST", "/users", json=payload)

    def get_user(self, user_id: str) -> dict:
        return self._request("GET", "/users/" + user_id)

    def list_orders(self, page: int = 1) -> dict:
        return self._request("GET", "/orders", params={"page": page})

    def get_order(self, order_id: str) -> dict:
        return self._request("GET", "/orders/" + order_id)

    def iter_users(self, limit: int = 20):
        page = 1
        while page is not None:
            body = self.list_users(page=page, limit=limit)
            for item in body["items"]:
                yield item
            page = body.get("next_page")
`,
    },
  },

  // ── M03 ────────────────────────────────────────────────────────────────────
  {
    id: 'M03',
    section: 'M',
    title: 'Flask → FastAPI 迁移',
    category: 'refactor',
    difficulty: 'medium',
    prompt: '把这个 Flask 应用迁移到 FastAPI，接口保持兼容。',
    files: {
      'README.md': String.raw`# items-service

\`app_flask.py\` 是现网实现（Flask），要迁到 FastAPI。

迁移后：\`app.py\` 暴露 FastAPI 实例 \`app\`，三个接口的**状态码与响应字段名**必须与现网一致。

\`\`\`bash
pytest -q
\`\`\`
`,
      'app_flask.py': String.raw`from flask import Flask, jsonify, request

app = Flask(__name__)

ITEMS = {
    "1": {"id": "1", "name": "apple"},
    "2": {"id": "2", "name": "pear"},
}


@app.get("/items")
def list_items():
    return jsonify({"items": list(ITEMS.values()), "count": len(ITEMS)})


@app.get("/items/<item_id>")
def get_item(item_id):
    item = ITEMS.get(item_id)
    if item is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(item)


@app.post("/items")
def create_item():
    payload = request.get_json(silent=True) or {}
    if not payload.get("name"):
        return jsonify({"error": "name is required"}), 400
    item = {"id": str(len(ITEMS) + 1), "name": payload["name"]}
    ITEMS[item["id"]] = item
    return jsonify(item), 201
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_compat.py': String.raw`from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_list_items_shape_unchanged():
    response = client.get("/items")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"items", "count"}
    assert isinstance(body["items"], list)
    assert body["count"] == len(body["items"])


def test_get_item_shape_unchanged():
    assert client.get("/items/1").json() == {"id": "1", "name": "apple"}


def test_not_found_shape_unchanged():
    response = client.get("/items/999")
    assert response.status_code == 404
    assert response.json() == {"error": "not found"}


def test_create_item_shape_unchanged():
    response = client.post("/items", json={"name": "fig"})
    assert response.status_code == 201
    assert set(response.json()) == {"id", "name"}
    assert client.post("/items", json={}).status_code == 400
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    sourceAudits: [
      {
        label: '真迁移：app.py 用 FastAPI，不得把 Flask 包一层',
        file: 'app.py',
        mustMatch: 'fastapi',
        mustNotMatch: 'from flask|import flask',
        note: '测试集期望「Pydantic 模型 + 路由迁移」，否决项是响应结构变化',
      },
    ],
    boundaryChecks: [
      {
        name: '兼容性：错误响应结构一致',
        file: 'm03_error_shapes.py',
        note: '测试集否决项：响应结构变化',
        content: String.raw`import sys

from fastapi.testclient import TestClient

from app import app

client = TestClient(app)

missing = client.get("/items/404-not-here")
if missing.status_code != 404 or missing.json() != {"error": "not found"}:
    print("404 shape changed: " + str(missing.status_code) + " " + repr(missing.json()))
    sys.exit(1)

bad = client.post("/items", json={})
if bad.status_code != 400 or bad.json() != {"error": "name is required"}:
    print("400 shape changed: " + str(bad.status_code) + " " + repr(bad.json()))
    sys.exit(1)

created = client.post("/items", json={"name": "fig"})
body = created.json()
if created.status_code != 201 or set(body) != {"id", "name"} or not isinstance(body["id"], str):
    print("201 shape changed: " + str(created.status_code) + " " + repr(body))
    sys.exit(1)
print("compat shapes ok")
`,
      },
    ],
    alignment: [
      '测试集「Pydantic 模型 + 路由迁移 + 兼容测试」→ pure：read_file 读 Flask 实现 → write_file 写 FastAPI → execute_command 跑兼容测试',
      'flask/fastapi/httpx 都是环境依赖（已提供），否则无法验证「兼容」',
    ],
    golden: {
      'app.py': String.raw`from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="items-service")

ITEMS = {
    "1": {"id": "1", "name": "apple"},
    "2": {"id": "2", "name": "pear"},
}


class ItemIn(BaseModel):
    name: str | None = None


@app.get("/items")
def list_items():
    return {"items": list(ITEMS.values()), "count": len(ITEMS)}


@app.get("/items/{item_id}")
def get_item(item_id: str):
    item = ITEMS.get(item_id)
    if item is None:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return item


@app.post("/items", status_code=201)
def create_item(payload: ItemIn):
    if not payload.name:
        return JSONResponse(status_code=400, content={"error": "name is required"})
    item = {"id": str(len(ITEMS) + 1), "name": payload.name}
    ITEMS[item["id"]] = item
    return item
`,
    },
  },

  // ── M04 ────────────────────────────────────────────────────────────────────
  {
    id: 'M04',
    section: 'M',
    title: 'CSV → SQLite 导入器',
    category: 'feature',
    difficulty: 'medium',
    prompt: '读 CSV 导入 SQLite，列名自动建表，重复导入不重复插入。',
    files: {
      'README.md': String.raw`# csv2sqlite

\`\`\`bash
python import_csv.py data/orders.csv out.sqlite3
\`\`\`

- 表名 = CSV 文件名去掉扩展名；
- 列名 = 表头原样；
- 类型推断：该列全部非空值都能解析为整数 → INTEGER；都能解析为浮点 → REAL；否则 TEXT；
- **幂等**：同一行数据重复导入不重复插入（第二次导入行数不变）；追加的新行要能进库；
- 整个导入是一个事务（失败不留半截数据）。
`,
      'import_csv.py': String.raw`def import_csv(csv_path: str, db_path: str) -> int:
    raise NotImplementedError


if __name__ == "__main__":
    import sys

    import_csv(sys.argv[1], sys.argv[2])
`,
      'data/orders.csv': String.raw`id,name,amount
1,ada,10.5
2,bob,20
3,curie,30.25
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_import_csv.py': String.raw`import sqlite3
import subprocess
import sys
from pathlib import Path

SCRIPT = Path.cwd() / "import_csv.py"
SOURCE = Path.cwd() / "data" / "orders.csv"


def run(csv_path, db_path):
    return subprocess.run([sys.executable, str(SCRIPT), str(csv_path), str(db_path)], capture_output=True, text=True)


def seed_csv(tmp_path):
    target = tmp_path / "orders.csv"
    target.write_text(SOURCE.read_text(encoding="utf-8"), encoding="utf-8")
    return target


def test_import_is_idempotent_and_incremental(tmp_path):
    csv_path = seed_csv(tmp_path)
    db_path = tmp_path / "out.sqlite3"

    first = run(csv_path, db_path)
    assert first.returncode == 0, first.stderr
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("select count(*) from orders").fetchone()[0] == 3

    again = run(csv_path, db_path)
    assert again.returncode == 0, again.stderr
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("select count(*) from orders").fetchone()[0] == 3

    csv_path.write_text(csv_path.read_text(encoding="utf-8") + "4,dan,40\n", encoding="utf-8")
    third = run(csv_path, db_path)
    assert third.returncode == 0, third.stderr
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("select count(*) from orders").fetchone()[0] == 4


def test_column_types_are_inferred(tmp_path):
    csv_path = seed_csv(tmp_path)
    db_path = tmp_path / "typed.sqlite3"
    assert run(csv_path, db_path).returncode == 0
    with sqlite3.connect(db_path) as conn:
        types = {row[1]: row[2].upper() for row in conn.execute("pragma table_info(orders)")}
    assert types["id"] == "INTEGER"
    assert types["amount"] == "REAL"
    assert types["name"] == "TEXT"
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '幂等键必须覆盖全部列',
        file: 'm04_dedup_key.py',
        note: '测试集陷阱：类型推断 + 幂等；同一 CSV 内出现两行内容相同的数据也只应留下一行',
        content: String.raw`import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

script = Path.cwd() / "import_csv.py"
tmp = Path(tempfile.mkdtemp(prefix="csv2sqlite-"))
csv_path = tmp / "dup.csv"
csv_path.write_text("id,name\n1,ada\n1,ada\n2,bob\n", encoding="utf-8")
db_path = tmp / "dup.sqlite3"

result = subprocess.run([sys.executable, str(script), str(csv_path), str(db_path)], capture_output=True, text=True)
if result.returncode != 0:
    print("import failed: " + result.stderr.strip()[:200])
    sys.exit(1)

with sqlite3.connect(db_path) as conn:
    rows = conn.execute("select count(*) from dup").fetchone()[0]
if rows != 2:
    print("duplicate rows were inserted: " + str(rows) + " rows for 2 distinct records")
    sys.exit(1)
print("dedupe ok: 3 csv rows -> 2 stored rows")
`,
      },
    ],
    alignment: [
      '测试集「幂等 + 事务 + 测试」→ pure：write_file + execute_command（sqlite3 走标准库，无外部服务）',
    ],
    golden: {
      'import_csv.py': String.raw`import csv
import os
import sqlite3


def infer_type(values: list) -> str:
    present = [value for value in values if value != ""]
    if not present:
        return "TEXT"
    try:
        for value in present:
            int(value)
        return "INTEGER"
    except ValueError:
        pass
    try:
        for value in present:
            float(value)
        return "REAL"
    except ValueError:
        return "TEXT"


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def import_csv(csv_path: str, db_path: str) -> int:
    with open(csv_path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = [column.strip() for column in next(reader)]
        rows = [row for row in reader if any(cell != "" for cell in row)]

    table = os.path.splitext(os.path.basename(csv_path))[0]
    types = [infer_type([row[index] if index < len(row) else "" for row in rows]) for index in range(len(header))]

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            columns = ", ".join(quote(name) + " " + types[index] for index, name in enumerate(header))
            conn.execute("CREATE TABLE IF NOT EXISTS " + quote(table) + " (" + columns + ")")
            key = ", ".join(quote(name) for name in header)
            placeholders = ", ".join("?" for _ in header)
            for row in rows:
                values = []
                for index in range(len(header)):
                    raw = row[index] if index < len(row) else ""
                    if raw == "":
                        values.append(None)
                    elif types[index] == "INTEGER":
                        values.append(int(raw))
                    elif types[index] == "REAL":
                        values.append(float(raw))
                    else:
                        values.append(raw)
                where = " AND ".join(quote(name) + " IS ?" for name in header)
                exists = conn.execute(
                    "SELECT 1 FROM " + quote(table) + " WHERE " + where + " LIMIT 1",
                    values,
                ).fetchone()
                if exists is None:
                    conn.execute(
                        "INSERT INTO " + quote(table) + " (" + key + ") VALUES (" + placeholders + ")",
                        values,
                    )
        return conn.total_changes
    finally:
        conn.close()


if __name__ == "__main__":
    import sys

    import_csv(sys.argv[1], sys.argv[2])
`,
    },
  },

  // ── M05 ────────────────────────────────────────────────────────────────────
  {
    id: 'M05',
    section: 'M',
    title: '简单缓存层',
    category: 'feature',
    difficulty: 'medium',
    prompt: '给一个函数加 TTL 缓存，支持 maxsize。',
    files: {
      'README.md': String.raw`# ttl-cache

\`src/ttl_cache.py\` 暴露 \`TTLCache\`：

\`\`\`python
cache = TTLCache(maxsize=128, ttl=30, clock=time.monotonic)
value = cache.get_or_compute("key", lambda: expensive())
cache.stats  # {"hits": int, "misses": int, "evictions": int}
\`\`\`

- TTL **从写入时刻起算**（命中不续期）；过期后重新计算；
- 超过 maxsize 时淘汰**最久未被访问**的条目（LRU，命中/写入都算「被访问」）；
- \`clock\` 可注入（默认 \`time.monotonic\`），测试要用假时钟，不许 sleep。
`,
      'src/__init__.py': '',
      'src/ttl_cache.py': String.raw`class TTLCache:
    def __init__(self, maxsize: int, ttl: float, clock=None) -> None:
        raise NotImplementedError
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_ttl_cache.py': String.raw`from src.ttl_cache import TTLCache


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_ttl_counts_from_write_and_expires():
    clock = FakeClock()
    cache = TTLCache(maxsize=4, ttl=10, clock=clock)
    calls = []
    compute = lambda: (calls.append(1), "v")[1]

    assert cache.get_or_compute("k", compute) == "v"
    clock.now = 5.0
    assert cache.get_or_compute("k", compute) == "v"
    assert len(calls) == 1

    clock.now = 11.0
    assert cache.get_or_compute("k", compute) == "v"
    assert len(calls) == 2
    assert cache.stats["hits"] == 1
    assert cache.stats["misses"] == 2


def test_maxsize_evicts_least_recently_used():
    clock = FakeClock()
    cache = TTLCache(maxsize=2, ttl=100, clock=clock)
    cache.get_or_compute("a", lambda: "a")
    cache.get_or_compute("b", lambda: "b")
    cache.get_or_compute("a", lambda: "a")
    cache.get_or_compute("c", lambda: "c")
    assert cache.stats["evictions"] == 1

    recomputed = []
    assert cache.get_or_compute("b", lambda: (recomputed.append("b"), "b")[1]) == "b"
    assert recomputed == ["b"]
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    boundaryChecks: [
      {
        name: '过期条目不得占满 maxsize',
        file: 'm05_expiry.py',
        note: '测试集陷阱：TTL 过期与 maxsize 淘汰策略的组合',
        content: String.raw`import sys

from src.ttl_cache import TTLCache


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


clock = FakeClock()
cache = TTLCache(maxsize=2, ttl=1, clock=clock)
cache.get_or_compute("a", lambda: "a")
cache.get_or_compute("b", lambda: "b")
clock.now = 2.0
cache.get_or_compute("c", lambda: "c")
if cache.stats["misses"] != 3:
    print("expected 3 misses, got " + repr(cache.stats))
    sys.exit(1)
if cache.get_or_compute("a", lambda: "a") != "a":
    print("value corrupted after expiry")
    sys.exit(1)
print("expiry + eviction ok")
`,
      },
    ],
    sourceAudits: [
      {
        label: '反例：直接用 lru_cache 忽略 TTL（-10）',
        file: 'src/ttl_cache.py',
        mustNotMatch: 'lru_cache',
        note: '测试集反例',
      },
    ],
    alignment: [
      '测试集「LRU + TTL 组合，测试覆盖」→ pure：write_file + execute_command；假时钟注入是代码契约里的事',
    ],
    golden: {
      'src/ttl_cache.py': String.raw`import time
from collections import OrderedDict


class TTLCache:
    def __init__(self, maxsize: int, ttl: float, clock=None) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be at least 1")
        self._maxsize = maxsize
        self._ttl = ttl
        self._clock = clock or time.monotonic
        self._entries = OrderedDict()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    @property
    def stats(self) -> dict:
        return {"hits": self._hits, "misses": self._misses, "evictions": self._evictions}

    def get_or_compute(self, key, compute):
        entry = self._entries.get(key)
        if entry is not None and self._clock() - entry[0] < self._ttl:
            self._hits += 1
            self._entries.move_to_end(key)
            return entry[1]

        self._misses += 1
        value = compute()
        self._entries[key] = (self._clock(), value)
        self._entries.move_to_end(key)
        while len(self._entries) > self._maxsize:
            self._entries.popitem(last=False)
            self._evictions += 1
        return value
`,
    },
  },

  // ── M06 ────────────────────────────────────────────────────────────────────
  {
    id: 'M06',
    section: 'M',
    title: '日志解析脚本',
    category: 'feature',
    difficulty: 'medium',
    prompt: '解析 nginx access log，输出 top 10 IP、top 10 路径、状态码分布。',
    files: {
      'README.md': String.raw`# nginx-stats

\`\`\`bash
python parse_log.py access.log
\`\`\`

输出恰好三段，顺序固定，段内按 count 降序、count 相同按值升序，每段最多 10 行：

\`\`\`
[top ips]
<count>\t<ip>
[top paths]
<count>\t<path>
[status]
<count>\t<status>
\`\`\`

- \`path\` 是请求路径，**不含 query string**；
- 解析不了的行直接跳过（不进任何统计，也不报错退出）。
`,
      'parse_log.py': String.raw`def summarize(path: str) -> dict:
    raise NotImplementedError


if __name__ == "__main__":
    import sys

    print(summarize(sys.argv[1]))
`,
      'access.log': String.raw`10.0.0.1 - - [11/Sep/2026:10:00:01 +0800] "GET /index.html HTTP/1.1" 200 512 "-" "curl/8.0"
10.0.0.2 - - [11/Sep/2026:10:00:02 +0800] "GET /api/orders?page=2 HTTP/1.1" 200 1024 "-" "curl/8.0"
10.0.0.1 - - [11/Sep/2026:10:00:03 +0800] "POST /api/orders HTTP/1.1" 201 64 "-" "curl/8.0"
10.0.0.3 - - [11/Sep/2026:10:00:04 +0800] "GET /index.html HTTP/1.1" 304 0 "-" "curl/8.0"
10.0.0.1 - - [11/Sep/2026:10:00:05 +0800] "GET /missing HTTP/1.1" 404 128 "-" "curl/8.0"
10.0.0.4 - - [11/Sep/2026:10:00:06 +0800] "GET /api/orders?page=1 HTTP/1.1" 200 2048 "-" "curl/8.0"
10.0.0.2 - - [11/Sep/2026:10:00:07 +0800] "DELETE /api/orders/9 HTTP/1.1" 500 0 "-" "curl/8.0"
not a log line at all
10.0.0.5 - - [11/Sep/2026:10:00:08 +0800] "GET /index.html HTTP/1.1" 200 512 "-" "curl/8.0"
10.0.0.1 - - [11/Sep/2026:10:00:09 +0800] "GET /api/orders?page=3 HTTP/1.1" 500 0 "-" "curl/8.0"
broken
10.0.0.2 - - [11/Sep/2026:10:00:10 +0800] "GET /api/users HTTP/1.1" 200 256 "-" "curl/8.0"
10.0.0.3 - - [11/Sep/2026:10:00:11 +0800] "GET /api/users HTTP/1.1" 200 256 "-" "curl/8.0"
10.0.0.2 - - [11/Sep/2026:10:00:12 +0800] "GET /api/users HTTP/1.1" 500 0 "-" "curl/8.0"
10.0.0.4 - - [11/Sep/2026:10:00:13 +0800] "GET /missing HTTP/1.1" 404 128 "-" "curl/8.0"
"GET unquoted" garbage
10.0.0.6 - - [11/Sep/2026:10:00:14 +0800] "GET /index.html HTTP/1.1" 200 512 "-" "curl/8.0"
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_parse_log.py': String.raw`import subprocess
import sys

EXPECTED = {
    "ips": [(4, "10.0.0.1"), (4, "10.0.0.2"), (2, "10.0.0.3"), (2, "10.0.0.4"), (1, "10.0.0.5"), (1, "10.0.0.6")],
    "paths": [(4, "/api/orders"), (4, "/index.html"), (3, "/api/users"), (2, "/missing"), (1, "/api/orders/9")],
    "status": [(7, "200"), (3, "500"), (2, "404"), (1, "201"), (1, "304")],
}


def sections() -> dict:
    result = subprocess.run([sys.executable, "parse_log.py", "access.log"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    parsed = {}
    current = None
    for raw in result.stdout.splitlines():
        line = raw.rstrip()
        if line.startswith("[top ips]"):
            current = "ips"
            parsed[current] = []
        elif line.startswith("[top paths]"):
            current = "paths"
            parsed[current] = []
        elif line.startswith("[status]"):
            current = "status"
            parsed[current] = []
        elif line.strip() and current:
            count, value = line.split("\t")
            parsed[current].append((int(count), value))
    return parsed


def test_sections_match_expected_counts():
    assert sections() == EXPECTED


def test_paths_drop_query_strings():
    paths = sections()["paths"]
    assert all("?" not in value for _, value in paths)


def test_max_ten_rows_per_section():
    for rows in sections().values():
        assert len(rows) <= 10
`,
    },
    verification: [{ name: 'pytest', command: 'pytest', args: ['-q'] }],
    sourceAudits: [
      {
        label: '反例：全量读入内存（-10，1GB log 会 OOM）',
        file: 'parse_log.py',
        mustNotMatch: '\\.read\\(\\)|readlines\\(',
        note: '测试集反例：期望正则 + 容错 + 流式',
      },
    ],
    alignment: [
      '测试集「正则 + 容错 + 流式」→ pure：write_file + execute_command 跑样例 log',
      '流式是源码级反例（1GB log 无法在验收里真造），用源码扫描复核，不进 pass/fail',
    ],
    golden: {
      'parse_log.py': String.raw`import re
import sys
from collections import Counter

LINE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[[^\]]+\] "(?P<method>[A-Z]+) (?P<path>[^ ]*) [^"]*" (?P<status>\d{3}) '
)


def summarize(path: str) -> dict:
    ips = Counter()
    paths = Counter()
    statuses = Counter()
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            match = LINE.match(line)
            if not match:
                continue
            ips[match.group("ip")] += 1
            paths[match.group("path").split("?")[0]] += 1
            statuses[match.group("status")] += 1
    return {
        "ips": sorted(ips.items(), key=lambda item: (-item[1], item[0]))[:10],
        "paths": sorted(paths.items(), key=lambda item: (-item[1], item[0]))[:10],
        "status": sorted(statuses.items(), key=lambda item: (-item[1], item[0]))[:10],
    }


def render(summary: dict) -> str:
    lines = ["[top ips]"]
    lines += [str(count) + "\t" + value for value, count in summary["ips"]]
    lines.append("[top paths]")
    lines += [str(count) + "\t" + value for value, count in summary["paths"]]
    lines.append("[status]")
    lines += [str(count) + "\t" + value for value, count in summary["status"]]
    return "\n".join(lines)


if __name__ == "__main__":
    print(render(summarize(sys.argv[1])))
`,
    },
  },

  // ── M07 ────────────────────────────────────────────────────────────────────
  {
    id: 'M07',
    section: 'M',
    title: '单元测试补全',
    category: 'feature',
    difficulty: 'medium',
    prompt: '这个模块覆盖率只有 20%，补到 ≥85%。',
    files: {
      'README.md': String.raw`# calc

\`calc.py\` 是待补覆盖率的模块，测试在 \`tests/\`。

\`\`\`bash
pytest -q --cov=calc --cov-fail-under=85
\`\`\`

测试要有真实断言（覆盖正常路径、边界与异常）。
`,
      'calc.py': String.raw`def add(a, b):
    return a + b


def sub(a, b):
    return a - b


def mul(a, b):
    return a * b


def div(a, b):
    if b == 0:
        raise ZeroDivisionError("division by zero")
    return a / b


def parse_int(text):
    text = text.strip()
    if not text:
        raise ValueError("empty input")
    return int(text)


def clamp(value, low, high):
    if low > high:
        raise ValueError("low must not exceed high")
    return max(low, min(high, value))
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_calc.py': String.raw`from calc import add, div


def test_add():
    assert add(1, 2) == 3


def test_div():
    assert div(4, 2) == 2
`,
    },
    verification: [
      { name: 'pytest + coverage', command: 'pytest', args: ['-q', '--cov=calc', '--cov-fail-under=85'] },
    ],
    sourceAudits: [
      {
        label: '反例：pragma: no cover（-50）',
        file: 'tests/test_calc.py',
        mustNotMatch: 'no cover|pragma',
        note: '测试集反例',
      },
      {
        label: '反例：空断言（-30）',
        file: 'tests/test_calc.py',
        mustNotMatch: 'assert\\s+(True|1)\\s*$',
        note: '测试集反例：真实断言，不许 assert True 刷覆盖',
      },
    ],
    boundaryChecks: [
      {
        name: '测试确实覆盖异常路径',
        file: 'm07_real_assertions.py',
        note: '测试集陷阱：诱导写空测试刷覆盖',
        content: String.raw`import re
import sys
from pathlib import Path

source = Path("tests/test_calc.py").read_text(encoding="utf-8")
assertions = re.findall(r"assert\s+\S", source)
raises = re.findall(r"pytest\.raises", source)
if len(assertions) < 8:
    print("too few real assertions: " + str(len(assertions)))
    sys.exit(1)
if len(raises) < 2:
    print("exception paths not covered (pytest.raises count=" + str(len(raises)) + ")")
    sys.exit(1)
print("assertions=" + str(len(assertions)) + " raises=" + str(len(raises)))
`,
      },
    ],
    alignment: [
      '测试集「覆盖率 ≥85%」→ pure：execute_command 跑 pytest --cov（pytest-cov 属环境依赖）',
      '反例「pragma: no cover / 空断言」→ 源码扫描 + 断言计数独立记录',
    ],
    golden: {
      'tests/test_calc.py': String.raw`import pytest

from calc import add, clamp, div, mul, parse_int, sub


def test_basic_arithmetic():
    assert add(1, 2) == 3
    assert sub(5, 2) == 3
    assert mul(3, 4) == 12
    assert div(4, 2) == 2


def test_division_by_zero():
    with pytest.raises(ZeroDivisionError):
        div(1, 0)


def test_parse_int():
    assert parse_int(" 42 ") == 42
    assert parse_int("-7") == -7
    with pytest.raises(ValueError):
        parse_int("   ")
    with pytest.raises(ValueError):
        parse_int("abc")


def test_clamp():
    assert clamp(5, 0, 10) == 5
    assert clamp(-1, 0, 10) == 0
    assert clamp(99, 0, 10) == 10
    with pytest.raises(ValueError):
        clamp(1, 10, 0)
`,
    },
  },

  // ── M08 ────────────────────────────────────────────────────────────────────
  {
    id: 'M08',
    section: 'M',
    title: 'SQL 查询优化',
    category: 'performance',
    difficulty: 'medium',
    prompt: '这个查询 P95 超过了 200ms，加索引优化到 200ms 以内，并说明权衡。',
    files: {
      'README.md': String.raw`# events-perf

\`schema.sql\` 是表结构，\`seed_data.py\` 造 30 万行数据，\`query.py\` 是线上那个查询，\`bench.py\` 是验收口径。

\`\`\`bash
python bench.py
pytest -q
\`\`\`

验收（\`bench.py\`）：

- 主要查询的执行计划必须走索引（不能是 \`SCAN events\`）；
- 200 次查询的 P95 ≤ 200ms。
`,
      'schema.sql': String.raw`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
`,
      'seed_data.py': String.raw`import os
import random
import sqlite3
import sys

ROWS = 300_000


def build(db_path: str, rows: int = ROWS) -> None:
    # 每次重建：bench / 测试会反复调用，旧库不能把它撞成 UNIQUE 冲突。
    if os.path.exists(db_path):
        os.remove(db_path)
    rng = random.Random(7)
    conn = sqlite3.connect(db_path)
    conn.executescript(open("schema.sql", encoding="utf-8").read())
    batch = [
        (index, rng.randint(1, 5000), ("ok", "error", "pending")[index % 3], 1_700_000_000_000 + index, "p" * 40)
        for index in range(1, rows + 1)
    ]
    conn.executemany(
        "INSERT INTO events (id, user_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?)", batch
    )
    conn.commit()
    conn.close()


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "perf.sqlite3")
`,
      'query.py': String.raw`def recent_for_user(conn, user_id: int, status: str, limit: int = 20):
    """按用户 + 状态取最近 limit 条。"""
    return conn.execute(
        "SELECT id, created_at FROM events WHERE user_id = ? AND status = ?"
        " ORDER BY created_at DESC LIMIT ?",
        (user_id, status, limit),
    ).fetchall()
`,
      'bench.py': String.raw`import random
import sqlite3
import sys
import time

from query import recent_for_user
from seed_data import build

DB = "perf.sqlite3"
ROWS = 300_000
SAMPLES = 200
SLO_MS = 200.0
MAIN_QUERY = (
    "SELECT id, created_at FROM events WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
)

build(DB, ROWS)
conn = sqlite3.connect(DB)

plan = [" ".join(str(part) for part in row) for row in conn.execute("EXPLAIN QUERY PLAN " + MAIN_QUERY, (1, "ok", 20))]
uses_index = any("USING INDEX" in step.upper() or "USING COVERING INDEX" in step.upper() for step in plan)
print("plan: " + " | ".join(plan))
if not uses_index:
    print("FAIL: the main query still scans the table")
    sys.exit(1)

rng = random.Random(11)
timings = []
for _ in range(SAMPLES):
    user_id = rng.randint(1, 5000)
    status = ("ok", "error", "pending")[rng.randint(0, 2)]
    started = time.perf_counter()
    recent_for_user(conn, user_id, status, 20)
    timings.append((time.perf_counter() - started) * 1000)
timings.sort()
p95 = timings[max(0, int(len(timings) * 0.95) - 1)]
print("p95=%.2fms over %d queries (SLO %.0fms)" % (p95, SAMPLES, SLO_MS))
if p95 > SLO_MS:
    print("FAIL: P95 exceeds the SLO")
    sys.exit(1)
print("bench ok")
`,
      'pyproject.toml': PYPROJECT,
      'tests/test_perf.py': String.raw`import sqlite3

from query import recent_for_user
from seed_data import build

MAIN_QUERY = (
    "SELECT id, created_at FROM events WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
)


def test_recent_for_user_keeps_behavior(tmp_path):
    db = tmp_path / "small.sqlite3"
    conn = sqlite3.connect(db)
    conn.executescript(open("schema.sql", encoding="utf-8").read())
    conn.executemany(
        "INSERT INTO events (id, user_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?)",
        [
            (1, 7, "ok", 100, "x"),
            (2, 7, "ok", 300, "x"),
            (3, 7, "ok", 200, "x"),
            (4, 8, "ok", 400, "x"),
            (5, 7, "error", 500, "x"),
        ],
    )
    conn.commit()

    rows = recent_for_user(conn, 7, "ok", 20)
    assert [row[0] for row in rows] == [2, 3, 1]
    assert [row[1] for row in rows] == [300, 200, 100]
    assert recent_for_user(conn, 7, "error", 20)[0][0] == 5


def test_plan_uses_an_index():
    conn = sqlite3.connect(":memory:")
    conn.executescript(open("schema.sql", encoding="utf-8").read())
    plan = [" ".join(str(part) for part in row) for row in conn.execute("EXPLAIN QUERY PLAN " + MAIN_QUERY, (1, "ok", 20))]
    assert any("USING INDEX" in step.upper() or "USING COVERING INDEX" in step.upper() for step in plan), plan
`,
    },
    verification: [
      { name: 'bench (P95 + 执行计划)', command: 'python3', args: ['bench.py'], timeoutMs: 300_000 },
      { name: 'pytest', command: 'pytest', args: ['-q'] },
    ],
    answerAudits: [
      {
        label: '人工评审：是否说明写开销/权衡',
        pattern: '写(入)?(开销|放大|成本|代价)|insert|INSERT|写入性能|写操作',
        note: '测试集人工评审项：加索引可能伤写入，是否说明权衡',
      },
    ],
    alignment: [
      '测试集「EXPLAIN 走索引 + 压测达标 + 说明权衡」→ pure：execute_command 跑 bench/pytest（sqlite 标准库，无外部 DB）',
      '「说明权衡」无自动验收，落进回答审计 + 人类表达评分',
    ],
    golden: {
      'schema.sql': String.raw`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_user_status_created
  ON events (user_id, status, created_at DESC);
`,
    },
  },
];
