// Stands in for a game: allocates a block of memory, then touches every page in a loop, like frames, and reports the timings.
// Usage: node game.cjs <megabytes> <seconds>
const { writeSync } = require('node:fs')

const [megabytes, seconds] = [Number(process.argv[2]), Number(process.argv[3])]
const page = 4096
const chunkBytes = 128 * 1024 * 1024
const chunks = []
const started = performance.now()
let slowestChunk = 0
for (let made = 0; made < megabytes; made += 128) {
  const before = performance.now()
  chunks.push(Buffer.allocUnsafeSlow(chunkBytes).fill(1))
  slowestChunk = Math.max(slowestChunk, performance.now() - before)
}
const allocation = performance.now() - started

const passes = []
const end = performance.now() + seconds * 1000
while (performance.now() < end) {
  const before = performance.now()
  for (const chunk of chunks) for (let offset = 0; offset < chunkBytes; offset += page) chunk[offset]++
  passes.push(performance.now() - before)
}
passes.sort((a, b) => a - b)
writeSync(1, JSON.stringify({
  allocation, slowestChunk, passes: passes.length, medianPass: passes[passes.length >> 1], slowestPass: passes.at(-1),
}) + '\n')
