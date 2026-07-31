// Run every headless suite, without a browser.
//
//   node --experimental-loader=./tools/three-loader.mjs tools/run-tests.mjs
//   node --experimental-loader=./tools/three-loader.mjs tools/run-tests.mjs creature -v
//
// Prints only failures unless given `-v`, takes a substring to run one suite,
// and exits with the failure count so a hook or a CI step can use it.
//
// `mood.test.js` is deliberately absent: it takes a live `GAME` and measures
// real pixels, so it needs the browser rig in tests/index.html. Everything else
// here is pure CPU and has no reason to.

// The same list tests/index.html runs, minus the art-direction suite: that one
// takes a live `GAME` and measures real pixels, so it needs the browser rig.
const SUITES = [
  ['control polarity', '../tests/controls.test.js'],
  ['ship signature', '../tests/signature.test.js'],
  ['light registry', '../tests/lights.test.js'],
  ['creature contract', '../tests/creature.test.js'],
];

const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const only = args.find((a) => !a.startsWith('-'));

let pass = 0, fail = 0, total = 0;

for (const [label, spec] of SUITES) {
  if (only && !label.toLowerCase().includes(only.toLowerCase())) continue;
  const t0 = performance.now();
  let r;
  try {
    const mod = await import(spec);
    r = await mod.run();
  } catch (err) {
    // A suite that will not load is a failure, loudly. A broken module graph has
    // taken this project's page down before.
    console.log(`\n${label} — DID NOT LOAD\n  ${err}`);
    fail++; total++;
    continue;
  }
  const fails = r.fail ?? r.results.filter((x) => !x.ok);
  pass += r.pass; fail += fails.length; total += r.results.length;

  console.log(`\n${label} — ${r.pass}/${r.results.length}` +
    `${fails.length ? `  ${fails.length} FAILED` : '  ok'}  (${(performance.now() - t0).toFixed(0)} ms)`);
  for (const x of r.results) {
    if (x.ok && !verbose) continue;
    console.log(`  ${x.ok ? 'pass' : 'FAIL'}  ${x.name}`);
    const detail = x.note ?? (typeof x.detail === 'string' ? x.detail : null);
    if (x.want !== undefined) console.log(`        want ${x.want} | got ${x.got}`);
    if (detail) console.log(`        ${detail}`);
  }
}

console.log(`\n${fail ? `${fail} FAILED — ` : ''}${pass}/${total} passed`);
process.exitCode = Math.min(fail, 125);
