const fs = require('fs');
const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('Usage: node scripts/compareQueryIndexBenchmarks.cjs before.json after.json');
  process.exit(1);
}
function readBenchmark(file) {
  const bytes = fs.readFileSync(file);
  let content;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    // Windows PowerShell's > redirection commonly writes UTF-16LE.
    content = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    content = swapped.toString('utf16le');
  } else {
    content = bytes.toString('utf8').replace(/^\uFEFF/, '');
  }
  return JSON.parse(content);
}
const before = readBenchmark(beforeFile);
const after = readBenchmark(afterFile);
const later = new Map(after.measurements.map(row => [row.name, row]));
for (const first of before.measurements) {
  const second = later.get(first.name);
  if (!second) continue;
  const change = first.medianExecutionMs > 0
    ? ((first.medianExecutionMs - second.medianExecutionMs) / first.medianExecutionMs * 100).toFixed(1)
    : 'n/a';
  const result = change === 'n/a' ? change : Number(change) === 0
    ? 'no measurable change'
    : `${Math.abs(Number(change)).toFixed(1)}% ${Number(change) > 0 ? 'faster' : 'slower'}`;
  console.log(`${first.name}: ${first.medianExecutionMs} -> ${second.medianExecutionMs} ms (${result}); rows ${first.rows} -> ${second.rows}; ${first.topPlanNode} -> ${second.topPlanNode}`);
}
console.log('Compare on the same database and similar data volume. Small absolute times are noisy; inspect plans and repeat measurements.');
