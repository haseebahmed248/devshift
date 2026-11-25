// Keeps one CPU core busy and reports how much work it finished every 250 ms, as "<work units> <milliseconds>".
const { writeSync } = require('node:fs')

let value = 1
let units = 0
let mark = performance.now()
for (;;) {
  for (let i = 0; i < 20_000; i++) value = Math.sqrt(value + i) * 1.000001
  units++
  const now = performance.now()
  if (now - mark >= 250) {
    // writeSync, because this loop never yields to let an asynchronous write flush.
    writeSync(1, `${units} ${now - mark} ${value > 0 ? 1 : 0}\n`)
    units = 0
    mark = now
  }
}
