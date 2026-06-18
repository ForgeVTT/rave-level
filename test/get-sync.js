'use strict'

const test = require('tape')
const tempy = require('./util/tempy')
const { fork } = require('child_process')
const { once } = require('events')
const { RaveLevel } = require('..')

if (process.argv[2] === 'child') {
  (async () => {
    const [location] = process.argv.slice(3)
    const db = new RaveLevel(location, { valueEncoding: 'json' })

    try {
      await db.open()

      process.send({
        isLeader: db.isLeader,
        value: db.getSync('a'),
        missing: db.getSync('missing')
      })

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
  test('getSync from follower process', async function (t) {
    const location = tempy.directory()
    const leader = new RaveLevel(location, { valueEncoding: 'json' })
    const value = { number: Math.floor(Math.random() * 100000) }

    await once(leader, 'leader')
    await leader.put('a', value)

    const result = await new Promise((resolve, reject) => {
      const child = fork(__filename, ['child', location], { timeout: 30e3 })
      let message = null

      child.on('message', msg => {
        message = msg
      })

      child.on('error', reject)

      child.on('exit', (code, signal) => {
        resolve({ code, signal, message })
      })
    })

    t.is(result.code, 0)
    t.is(result.signal, null)
    t.is(result.message && result.message.error, undefined)
    t.is(result.message && result.message.isLeader, false)
    t.same(result.message && result.message.value, value)
    t.is(result.message && result.message.missing, undefined)

    await leader.close()
  })
}
