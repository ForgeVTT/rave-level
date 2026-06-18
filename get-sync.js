'use strict'

const ModuleError = require('module-error')
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads')

const leaders = new Map()

// HERE BE DRAGONS
//
// getSync() must be synchronous from abstract-level's perspective, but a follower can only reach the leader through async socket IO.
// We do that async work in a worker thread, then block this thread with Atomics.wait() until the worker replies.
// This exists because real LevelDB getSync() blocks too, and some callers may require the sync API surface.

// If you are wondering why God has forsaken us and given us JavaScript: same.
// This is the pinnacle of cursed code and war crimes. A monstrocity that should never have been born,
// let alone be considered "useful" for any situation other than inflicting psychological damage.
exports.createGetSync = function createGetSync (socketPath) {
  let syncRead

  return function getSync (key, options) {
    if (options.snapshot !== undefined) {
      throw new ModuleError('Snapshots are not supported by rave-level getSync() followers', {
        code: 'LEVEL_NOT_SUPPORTED'
      })
    }

    const leader = leaders.get(socketPath)

    if (leader !== undefined) {
      return leader._getSync(key, options)
    }

    if (syncRead === undefined) {
      syncRead = createSyncReadWorker()
    }

    return syncRead({ socketPath, key })
  }
}

exports.registerLeader = function registerLeader (socketPath, db) {
  leaders.set(socketPath, db)

  return function unregisterLeader () {
    if (leaders.get(socketPath) === db) {
      leaders.delete(socketPath)
    }
  }
}

function createSyncReadWorker () {
  const { port1, port2 } = new MessageChannel()
  const worker = new Worker(syncReadWorkerCode(), {
    eval: true,
    workerData: { port: port2 },
    transferList: [port2]
  })

  worker.unref()
  port1.unref()

  return function syncRead (payload) {
    const semaphore = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

    worker.postMessage({ payload, semaphore })

    Atomics.wait(semaphore, 0, 0)

    const message = receiveMessageOnPort(port1).message

    if (message.error) {
      throw remoteError(message.error)
    }

    return message.value === undefined ? undefined : Buffer.from(message.value)
  }
}

function remoteError (error) {
  const err = new ModuleError(error.message || 'Could not get value', {
    code: error.code || 'LEVEL_REMOTE_ERROR'
  })

  if (error.stack) err.stack = error.stack
  return err
}

function syncReadWorkerCode () {
  return `
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
  `
}
