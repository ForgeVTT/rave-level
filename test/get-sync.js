'use strict'

const test = require('tape')
const tempy = require('./util/tempy')
const { fork } = require('child_process')
const { RaveLevel } = require('..')
const { ClassicLevel } = require('classic-level')

if (process.argv[2] === 'child') {
  (async () => {
    const [mode, location] = process.argv.slice(3)
    const db = new RaveLevel(location, { valueEncoding: 'json' })

    try {
      await db.open()

      if (mode === 'blocks') {
        let immediateRan = false
        setImmediate(() => {
          immediateRan = true
        })

        const value = db.getSync('a')
        const immediateRanDuringGetSync = immediateRan

        await new Promise(resolve => setImmediate(resolve))

        process.send({
          isLeader: db.isLeader,
          value,
          immediateRanDuringGetSync,
          immediateRanAfterGetSync: immediateRan
        })
      } else {
        process.send({
          isLeader: db.isLeader,
          value: db.getSync('a'),
          missing: db.getSync('missing')
        })
      }

      await db.close()
      process.exit(0)
    } catch (err) {
      process.send({
        error: err.message,
        code: err.code,
        stack: err.stack
      })
      process.exit(1)
    }
  })()
} else {
  function spawnChild (mode, location) {
    return new Promise((resolve, reject) => {
      const child = fork(__filename, ['child', mode, location], { timeout: 30e3 })
      let message = null

      child.on('message', msg => {
        message = msg
      })

      child.on('error', reject)

      child.on('exit', (code, signal) => {
        resolve({ code, signal, message })
      })
    })
  }

  async function withDelayedLeaderGets (fn) {
    const originalGet = ClassicLevel.prototype._get

    ClassicLevel.prototype._get = async function (...args) {
      await new Promise(resolve => setTimeout(resolve, 50))
      return originalGet.apply(this, args)
    }

    try {
      return await fn()
    } finally {
      ClassicLevel.prototype._get = originalGet
    }
  }

  test('getSync from follower process', async function (t) {
    const location = tempy.directory()
    const leader = new RaveLevel(location, { valueEncoding: 'json' })
    const value = { number: Math.floor(Math.random() * 100000) }

    await leader.put('a', value)

    const result = await spawnChild('basic', location)

    t.is(result.code, 0)
    t.is(result.signal, null)
    t.is(result.message && result.message.error, undefined)
    t.is(result.message && result.message.isLeader, false)
    t.same(result.message && result.message.value, value)
    t.is(result.message && result.message.missing, undefined)

    await leader.close()
  })

  test('getSync from follower process blocks the event loop', async function (t) {
    const location = tempy.directory()
    const leader = new RaveLevel(location, { valueEncoding: 'json' })
    const value = { number: Math.floor(Math.random() * 100000) }

    await leader.put('a', value)

    const result = await withDelayedLeaderGets(() => {
      return spawnChild('blocks', location)
    })

    t.is(result.code, 0)
    t.is(result.signal, null)
    t.is(result.message && result.message.error, undefined)
    t.is(result.message && result.message.isLeader, false)
    t.same(result.message && result.message.value, value)
    t.is(result.message && result.message.immediateRanDuringGetSync, false)
    t.is(result.message && result.message.immediateRanAfterGetSync, true)

    await leader.close()
  })
}
