'use strict'

const { workerData, parentPort } = require('worker_threads')
const net = require('net')
const { ManyLevelGuest } = require('many-level')

const port = workerData.port

parentPort.on('message', async function ({ payload, semaphore }) {
  try {
    const value = await get(payload.socketPath, payload.key)
    port.postMessage({ value })
  } catch (err) {
    port.postMessage({
      error: {
        code: err && err.code,
        message: err && err.message,
        stack: err && err.stack
      }
    })
  } finally {
    Atomics.store(semaphore, 0, 1)
    Atomics.notify(semaphore, 0, 1)
  }
})

async function get (socketPath, key) {
  const db = new ManyLevelGuest({
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    retry: false,
    _remote: () => net.connect(socketPath)
  })

  await db.open()

  try {
    return await db.get(Buffer.from(key), {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer'
    })
  } finally {
    await db.close()
  }
}
