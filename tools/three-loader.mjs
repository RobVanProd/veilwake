// Resolve the bare `three` specifier to the vendored copy, for node.
//
// `tests/index.html` does this with an importmap. Node has no importmap, and the
// only module in the test graph that imports `three` is `flight.js`, so five
// lines here are the whole difference between "the tests need a browser" and
// "the tests run anywhere". Which matters more than it sounds: this project has
// been developed in environments with no GPU and no display, and a test that
// cannot be run in one of those is a test that stops being run.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const THREE = pathToFileURL(
  path.resolve(import.meta.dirname, '../vendor/three.module.js')).href;

export function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: THREE, shortCircuit: true };
  return next(specifier, context);
}
