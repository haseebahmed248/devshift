// Holds memory like a background app, and answers on stdin and HTTP so the measurement can tell when it responds again.
// Usage: node hog.cjs <megabytes> <random|mixed> <idle|active>
const { randomFillSync } = require('node:crypto')
const { writeSync } = require('node:fs')
const { createServer } = require('node:http')
const { createInterface } = require('node:readline')

const [megabytes, fill, activity] = [Number(process.argv[2]), process.argv[3], process.argv[4]]
const page = 4096
const chunkBytes = 64 * 1024 * 1024
const pagesPerChunk = chunkBytes / page
const chunks = []
for (let made = 0; made < megabytes; made += 64) {
  const chunk = Buffer.allocUnsafeSlow(chunkBytes)
  randomFillSync(chunk)
  // Half of each page is constant, so it compresses about 2:1, which is closer to real app memory than random bytes.
  if (fill === 'mixed') for (let offset = 0; offset < chunkBytes; offset += page) chunk.fill(0x20, offset + page / 2, offset + page)
  chunks.push(chunk)
}
const pages = chunks.length * pagesPerChunk
const send = message => writeSync(1, JSON.stringify(message) + '\n')

if (activity === 'active') {
  // Writes to 1% of pages every 100 ms, like a heap that timers and garbage collection keep touching.
  let next = 0
  setInterval(() => {
    for (let i = 0; i < pages / 100; i++, next = (next + 1) % pages) chunks[Math.floor(next / pagesPerChunk)][(next % pagesPerChunk) * page]++
  }, 100)
}

const server = createServer((_request, response) => response.end('ok'))
server.keepAliveTimeout = 60_000
server.listen({ host: '127.0.0.1', port: 0 }, () => send({ ready: true, port: server.address().port }))

createInterface({ input: process.stdin })
  .on('line', line => {
    if (line === 'ping') send({ pong: true })
    if (line === 'touch') {
      const started = performance.now()
      let sum = 0
      for (const chunk of chunks) for (let offset = 0; offset < chunkBytes; offset += page) sum += chunk[offset]
      send({ touched: performance.now() - started, sum })
    }
  })
  .on('close', () => process.exit(0))
