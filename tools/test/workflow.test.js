'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yml = fs.readFileSync(path.join(__dirname, '../../.github/workflows/extend-lines.yml'), 'utf8');
const pagesWithStages = fs.readdirSync(path.join(__dirname, '../../openings'), { withFileTypes: true })
  .filter(function (d) { return d.isDirectory() && fs.readFileSync(path.join(__dirname, '../../openings', d.name, 'index.html'), 'utf8').includes('id="stagePicker"'); })
  .map(function (d) { return d.name; });

test('workflow only offers openings whose trainer has the stage control', function () {
  const block = yml.slice(yml.indexOf('options:'), yml.indexOf('permissions:'));
  const offered = (block.match(/^\s+- ([a-z-]+)$/gm) || []).map(function (l) { return l.trim().slice(2); });
  assert.deepEqual(offered.sort(), pagesWithStages.sort());
});

test('workflow shows the report on the run page even when no pull request is opened', function () {
  assert.match(yml, /if: always\(\)[\s\S]*report\.md[\s\S]*GITHUB_STEP_SUMMARY/);
});

test('workflow installs without dev dependencies or install scripts, and has a time limit', function () {
  assert.match(yml, /npm ci --omit=dev --ignore-scripts/);
  assert.match(yml, /timeout-minutes: \d+/);
});
