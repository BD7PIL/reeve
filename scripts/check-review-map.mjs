#!/usr/bin/env node
// Gate for the review skill's rule map.
//
//   node scripts/check-review-map.mjs --check
//   node scripts/check-review-map.mjs --write
//   node scripts/check-review-map.mjs --skill <path> [--skill <path>] --check
//
// What it asserts:
//   1. every file listed in review-map.json exists under plugin/skills/review/
//   2. every rubric .md in that directory (except SKILL.md) is listed
//   3. every entry is either auto-selectable (non-empty globs) or contextOnly
//   4. no two auto-selectable entries claim the same glob
//   5. a table of representative paths resolves to the expected rubric
//   6. the generated table inside each SKILL.md matches review-map.json
//
// Exit 1 on any violation.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_DIR = join(ROOT, "plugin", "skills", "review");
const MAP_PATH = join(REVIEW_DIR, "review-map.json");
const DEFAULT_SKILLS = [join(REVIEW_DIR, "SKILL.md")];

const BEGIN = "<!-- BEGIN review-map -->";
const END = "<!-- END review-map -->";

const GROUP_TITLES = {
  language: "语言",
  config: "配置与构建",
  template: "模板",
  infra: "基础设施与 IDL",
  fallback: "兜底",
};

// Representative paths -> expected rubric. Kept small on purpose: it pins the
// semantics (which file wins, and where the fallback starts), not every glob.
const CASES = [
  ["src/app.ts", "ts_js_tsx_jsx.md"],
  ["src/app.tsx", "ts_js_tsx_jsx.md"],
  ["src/app.js", "ts_js_tsx_jsx.md"],
  ["scripts/build.mjs", "ts_js_tsx_jsx.md"],
  ["scripts/legacy.cjs", "ts_js_tsx_jsx.md"],
  [".github/workflows/ci.yml", "github_workflows.md"],
  [".github/workflows/nested/release.yaml", "github_workflows.md"],
  [".github/dependabot.yml", "github_config.md"],
  [".github/ISSUE_TEMPLATE/config.yml", "github_config.md"],
  [".github/actions/setup/action.yml", "github_config.md"],
  ["docker-compose.yml", "yaml.md"],
  ["cmd/main.go", "go.md"],
  ["api/service.proto", "protobuf.md"],
  ["tsconfig.jsonc", "json.md"],
  ["pom.xml", "pom_xml.md"],
  ["Cargo.toml", "cargo_toml.md"],
  ["package.json", "package_json.md"],
  ["src/main/resources/UserMapper.xml", "mapper_dao_xml.md"],
  ["BUILD.bazel", "starlark.md"],
  ["infra/main.tf", "terraform.md"],
  ["src/App.vue", "default.md"],
  ["deploy/run.sh", "default.md"],
  ["Dockerfile", "default.md"],
  ["Makefile", "default.md"],
  ["web/index.html", "default.md"],
];

function parseArgs(argv) {
  const opts = { mode: null, skills: [...DEFAULT_SKILLS], linkPrefix: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opts.mode = "check";
    else if (a === "--write") opts.mode = "write";
    else if (a === "--skill") {
      const p = argv[++i];
      if (!p) throw new Error("--skill needs a path");
      if (opts.skills.length === DEFAULT_SKILLS.length && opts.skills[0] === DEFAULT_SKILLS[0]) opts.skills = [];
      opts.skills.push(resolve(p));
    } else if (a === "--link-prefix") {
      const v = argv[++i];
      if (v === undefined) throw new Error('--link-prefix needs a value (use "" for none)');
      opts.linkPrefix = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.mode) throw new Error("pass --check or --write");
  if (opts.linkPrefix && opts.skills.length !== 1) throw new Error("--link-prefix applies to exactly one --skill");
  return opts;
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

function matchRubric(relPath, map) {
  const p = relPath.replace(/\\/g, "/");
  const base = p.split("/").pop();
  // Bucket 0: workflows always win. Bucket 1: exact filenames (package.json,
  // pom.xml, Cargo.toml) must beat wildcards such as *.json. Bucket 2: the rest.
  const bucket = (rule) => (rule.globs.length > 0 && rule.globs.every((g) => !/[*?]/.test(g)) ? 1 : 2);
  const ordered = [
    ...map.rules.filter((r) => r.file === "github_workflows.md"),
    ...map.rules
      .filter((r) => r.file !== "github_workflows.md" && !r.contextOnly && r.file !== map.fallback)
      .sort((a, b) => bucket(a) - bucket(b)),
  ];
  for (const rule of ordered) {
    for (const glob of rule.globs) {
      const target = glob.includes("/") ? p : base;
      if (globToRegExp(glob).test(target)) return rule.file;
    }
  }
  return map.fallback;
}

function renderTable(map, linkPrefix = "") {
  const out = [];
  const groups = ["language", "config", "template", "infra", "fallback"];
  for (const group of groups) {
    const rules = map.rules.filter((r) => r.group === group);
    if (rules.length === 0) continue;
    out.push(`### ${GROUP_TITLES[group]}`);
    out.push("");
    if (group === "fallback") {
      for (const rule of rules) {
        out.push(`- \`${linkPrefix}${rule.file}\` — 任何表外文件（上游未覆盖的格式，如 \`.sh\`、\`Dockerfile\`、\`Makefile\`、\`.html\`）。`);
      }
      out.push("");
      continue;
    }
    out.push("| 规则文件 | 适用 |");
    out.push("|---|---|");
    for (const rule of [...rules].sort((a, b) => a.file.localeCompare(b.file))) {
      const label = `\`${linkPrefix}${rule.file}\``;
      const globs = rule.contextOnly
        ? `**按需读取**（${rule.note ?? "上下文相关"}）`
        : rule.globs.map((g) => `\`${g}\``).join(" ");
      out.push(`| ${label} | ${globs} |`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "");
}

function readMap() {
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  if (!Array.isArray(map.rules) || map.rules.length === 0) throw new Error("review-map.json has no rules");
  if (!map.fallback) throw new Error("review-map.json has no fallback");
  return map;
}

function validate(map) {
  const problems = [];
  const seenGlobs = new Map();
  const files = map.rules.map((r) => r.file);
  const dupFiles = files.filter((f, i) => files.indexOf(f) !== i);
  if (dupFiles.length) problems.push(`duplicate file entries: ${[...new Set(dupFiles)].join(", ")}`);

  for (const rule of map.rules) {
    const abs = join(REVIEW_DIR, rule.file);
    if (!existsSync(abs)) problems.push(`missing rubric on disk: ${rule.file}`);
    const auto = !rule.contextOnly && rule.file !== map.fallback;
    if (auto && (!Array.isArray(rule.globs) || rule.globs.length === 0)) {
      problems.push(`${rule.file}: auto-selectable entry needs at least one glob`);
    }
    if (auto) {
      for (const glob of rule.globs) {
        const key = glob.toLowerCase();
        if (seenGlobs.has(key) && seenGlobs.get(key) !== rule.file) {
          problems.push(`glob conflict: ${glob} claimed by ${seenGlobs.get(key)} and ${rule.file}`);
        }
        seenGlobs.set(key, rule.file);
      }
    }
  }

  const onDisk = readdirSync(REVIEW_DIR)
    .filter((f) => f.endsWith(".md") && f !== "SKILL.md")
    .sort();
  const listed = new Set(files);
  for (const f of onDisk) if (!listed.has(f)) problems.push(`rubric on disk not in review-map.json: ${f}`);
  const onDiskSet = new Set(onDisk);
  for (const f of files) if (f !== "SKILL.md" && !onDiskSet.has(f)) problems.push(`review-map.json lists ${f} but it is not on disk`);

  if (!listed.has(map.fallback)) problems.push(`fallback ${map.fallback} is not in review-map.json`);

  for (const [path, expected] of CASES) {
    const actual = matchRubric(path, map);
    if (actual !== expected) problems.push(`case ${path}: expected ${expected}, got ${actual}`);
  }

  return problems;
}

function extractBlock(text, path) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end, body: text.slice(start + BEGIN.length, end) };
}

function checkSkill(path, map, linkPrefix) {
  if (!existsSync(path)) return [`SKILL.md not found: ${path}`];
  const text = readFileSync(path, "utf8");
  const block = extractBlock(text, path);
  if (!block) return [`${path}: missing ${BEGIN} / ${END} markers`];
  const expected = `\n${renderTable(map, linkPrefix)}\n`;
  const actual = block.body;
  const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\n+$/, "\n").replace(/^\n+/, "\n");
  if (norm(actual) !== norm(expected)) {
    return [`${path}: generated table is stale — run: node scripts/check-review-map.mjs --write`];
  }
  return [];
}

function writeSkill(path, map, linkPrefix) {
  if (!existsSync(path)) throw new Error(`SKILL.md not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const block = extractBlock(text, path);
  if (!block) throw new Error(`${path}: missing ${BEGIN} / ${END} markers`);
  const next = `${text.slice(0, block.start + BEGIN.length)}\n${renderTable(map, linkPrefix)}\n${text.slice(block.end)}`;
  writeFileSync(path, next);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const map = readMap();

  if (opts.mode === "write") {
    for (const path of opts.skills) writeSkill(path, map, opts.linkPrefix);
    console.log(`review-map: wrote ${opts.skills.length} SKILL.md file(s)`);
    return;
  }

  const problems = [...validate(map)];
  for (const path of opts.skills) problems.push(...checkSkill(path, map, opts.linkPrefix));

  if (problems.length) {
    console.error(`review-map gate failed: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`review-map gate: clean (${map.rules.length} rules, ${CASES.length} cases)`);
}

main();
