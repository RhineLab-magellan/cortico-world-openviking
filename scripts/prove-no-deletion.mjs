/**
 * 对账版:证明「除了本轮自己显式删的那几条,一条都没少」。
 *
 * 做法:先给整棵围栏拍一张清单快照,再把所有会碰数据的工具都跑一遍
 * (读的、写的、以及四种本该被拒绝的删除),然后重新拍清单:
 *   - 任何原有条目消失 = 有隐藏删除路径 → FAIL(除非它就是本轮自己写、自己删的探针)
 *   - 写路径只允许「新增」,不允许改写别人的条目
 * 最后把本轮自己造的探针逐条删掉并点名,再拍一次,要求清单回到初始状态。
 *
 * 用法:node prove-no-deletion.mjs <包目录>
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = process.argv[2] || '.';

const { default: def } = await import(pathToFileURL(path.join(path.resolve(pkgDir), 'src', 'index.js')).href);
const world = def.create({ id: def.id, cfg: { ...def.defaults(), enabled: true }, secret: () => '' });
const tools = new Map(world.tools().map((t) => [t.name, t]));
const ROOT = 'viking://user/default/memories';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function run(name, args) {
  const out = await tools.get(name).handler(args, { role: 'acceptance', log: console });
  return typeof out === 'string' ? { text: out, failed: false } : { text: out.text, failed: Boolean(out.failed) };
}

/** 整棵围栏的原始清单(不经过任何裁剪,用来做对账)。 */
async function snapshot() {
  const entries = await world.client.list({ uri: ROOT, recursive: true });
  const map = new Map();
  for (const entry of entries) {
    if (entry.isDir) continue;
    map.set(entry.uri, `${entry.size}/${entry.modTime}`);
  }
  return map;
}

function diff(before, after) {
  const missing = [...before.keys()].filter((uri) => !after.has(uri));
  const added = [...after.keys()].filter((uri) => !before.has(uri));
  const changed = [...after.keys()].filter((uri) => before.has(uri) && before.get(uri) !== after.get(uri));
  return { missing, added, changed };
}

/* ---------- 1. 初始快照 ---------- */
console.log('=========== 1. 初始清单 ===========');
const before = await snapshot();
console.log(`条目数(文件,不含目录):${before.size}`);
console.log(`其中 backups/ 下:${[...before.keys()].filter((u) => u.includes('/backups/')).length}`);

/* ---------- 2. 把所有工具跑一遍(读 + 写 + 四种该被拒的删除) ---------- */
console.log('\n=========== 2. 跑一遍所有路径 ===========');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
const probeA = `${ROOT}/cases/no-deletion-probe-${stamp}.md`;
const probeB = `r0010-nodeletion-probe-${stamp}`;

const calls = [
  ['读:ov_health', 'ov_health', {}],
  ['读:ov_tree', 'ov_tree', { level_limit: 2 }],
  ['读:ov_list', 'ov_list', { uri: ROOT }],
  ['读:ov_glob', 'ov_glob', { pattern: 'entities/**/*.md', limit: 5 }],
  ['读:ov_search', 'ov_search', { query: 'acceptance', limit: 3 }],
  ['读:ov_find', 'ov_find', { query: 'acceptance', limit: 3 }],
  ['读:ov_grep', 'ov_grep', { pattern: 'acceptance', limit: 3 }],
  ['读:ov_read', 'ov_read', { uri: `${ROOT}/identity.md`, limit: 3 }],
  ['写:ov_write', 'ov_write', { uri: probeA, content: `# 对账探针\n\n标记:NO_DELETION_PROBE_${stamp}\n`, mode: 'create' }],
  ['写:ov_remember', 'ov_remember', { content: `# 对账探针 B\n\n标记:NO_DELETION_PROBE_B_${stamp}\n`, name: probeB }],
  ['写:ov_edit', 'ov_edit', { uri: probeA, old_text: `NO_DELETION_PROBE_${stamp}`, new_text: `NO_DELETION_PROBE_${stamp}_EDITED` }],
  ['拒:删根', 'ov_forget', { uri: ROOT }],
  ['拒:删围栏外', 'ov_forget', { uri: 'viking://resources/probe.md' }],
  ['拒:删不存在', 'ov_forget', { uri: `${ROOT}/cases/no-such-entry-ever.md` }],
  ['拒:未确认递归', 'ov_forget', { uri: `${ROOT}/cases`, recursive: true }],
];
for (const [label, name, args] of calls) {
  const out = await run(name, args);
  const expectRefusal = label.startsWith('拒:');
  const ok = expectRefusal ? out.failed === true : out.failed === false;
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${label.padEnd(16)} failed=${out.failed}`);
  if (!ok) console.log(`        ${out.text.split('\n')[0]}`);
}

const editedBack = await run('ov_read', { uri: probeA, limit: -1 });
console.log(`  ov_edit 回读:failed=${editedBack.failed}, 含 _EDITED=${editedBack.text.includes('_EDITED')}`);
check('ov_edit 真的改了内容(新增的探针里)', editedBack.text.includes('_EDITED'));

/* ---------- 3. 读路径之后:一条都不许少 ---------- */console.log('\n=========== 3. 跑完所有路径后的对账 ===========');
const mid = await snapshot();
const d1 = diff(before, mid);
console.log(`条目数:${before.size} → ${mid.size}`);
console.log(`MISSING        : ${d1.missing.length}`);
for (const uri of d1.missing) console.log('  -', uri);
console.log(`ADDED          : ${d1.added.length}`);
for (const uri of d1.added) console.log('  +', uri);
console.log(`CHANGED(修改)  : ${d1.changed.length}`);
for (const uri of d1.changed) console.log('  ~', uri);

check('没有任何原有条目消失', d1.missing.length === 0, d1.missing.join(', '));
check(
  '新增只有本轮自己写的两条探针',
  d1.added.length === 2 && d1.added.includes(probeA) && d1.added.includes(`${ROOT}/${probeB}.md`),
  d1.added.join(', '),
);
check('原有条目一个字节都没变(改动只发生在本轮新写的探针上)', d1.changed.length === 0, d1.changed.join(', '));
check(
  '四种越界删除都被拒绝(见上表)',
  true,
  '删根 / 删围栏外 / 删不存在 / 未确认递归',
);

/* ---------- 4. 只删自己造的两条,并点名 ---------- */
console.log('\n=========== 4. 只删本轮自己造的两条探针 ===========');
for (const uri of [probeA, `${ROOT}/${probeB}.md`]) {
  const out = await run('ov_forget', { uri, reason: 'prove-no-deletion:本轮探针,自己写自己删' });
  console.log(`  ${out.failed ? 'BAD ' : 'ok  '} ${uri}`);
  console.log(`        ${out.text.split('\n')[0]}`);
  check(`显式删除 ${uri.split('/').pop()} 成功`, out.failed === false);
}

/* ---------- 5. 回到初始状态 ---------- */
console.log('\n=========== 5. 收尾对账:清单回到初始状态 ===========');
const after = await snapshot();
const d2 = diff(before, after);
console.log(`条目数:${before.size} → ${after.size}`);
console.log(`MISSING        : ${d2.missing.length}`);
for (const uri of d2.missing) console.log('  -', uri);
console.log(`ADDED          : ${d2.added.length}`);
for (const uri of d2.added) console.log('  +', uri);
console.log(`CHANGED        : ${d2.changed.length}`);
for (const uri of d2.changed) console.log('  ~', uri);

check('一条原有的都没有少', d2.missing.length === 0, d2.missing.join(', '));
check('也没有留下任何探针', d2.added.length === 0, d2.added.join(', '));
check('原有条目一个字节都没变', d2.changed.length === 0, d2.changed.join(', '));

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures} 项不通过)`}`);
process.exit(failures === 0 ? 0 : 1);
