// Run every test suite headless.
//
//   node --experimental-loader=./tools/three-loader.mjs tools/run-tests.mjs
//
// The same three suites `tests/index.html` runs, in the same order, printing
// each case's note rather than a bare verdict — a red light that does not say by
// how much sends the next person to re-derive a whole channel. Exit code is the
// number of failures, so this is usable from a hook or a CI step.
//
// Pass a suite name to run one: `... tools/run-tests.mjs listener`.

const SUITES = [
  ['control polarity', '../tests/controls.test.js'],
  ['ship signature', '../tests/systems.test.js'],
  ['the Listener', '../tests/listener.test.js'],
];

const only = process.argv[2];
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

let pass = 0, fail = 0, total = 0;

for (const [label, spec] of SUITES) {
  if (only && !label.toLowerCase().includes(only.toLowerCase())
      && !spec.includes(only)) continue;
  const t0 = performance.now();
  const { run } = await import(spec);
  const r = run();
  const ms = performance.now() - t0;
  pass += r.pass; fail += r.fail.length; total += r.results.length;

  const head = r.fail.length ? `${r.fail.length} FAILED` : 'ok';
  console.log(`\n${label} — ${r.pass}/${r.results.length} ${head}  (${ms.toFixed(0)} ms)`);
  for (const x of r.results) {
    if (x.ok && !verbose) continue;
    console.log(`  ${x.ok ? 'pass' : 'FAIL'}  ${x.name}`);
    console.log(`        want ${x.want} | got ${x.got}`);
    if (x.note) console.log(`        ${x.note}`);
  }
}

console.log(`\n${fail ? `${fail} FAILED — ` : ''}${pass}/${total} passed`);
process.exitCode = Math.min(fail, 125);
