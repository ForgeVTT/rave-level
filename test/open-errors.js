'use strict'

const test = require('tape')
const fs = require('fs')
const path = require('path')
const tempy = require('./util/tempy')
const { ClassicLevel } = require('classic-level')
const { RaveLevel } = require('..')

// tape does not time out on its own, and the bug these tests cover is a hang:
// open() resolving on failure and every operation waiting forever. Guard each
// await that would stall on a regression, so the suite fails fast instead.
function withTimeout (promise, ms, what) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Create a valid database at location and close it again
async function seed (location) {
  const db = new ClassicLevel(location, { valueEncoding: 'json' })
  await db.put('a', 1)
  await db.close()
}

// Point CURRENT at a manifest that does not exist, which is one of the ways a
// LevelDB directory ends up after a partial write. classic-level refuses to
// open it.
function corrupt (location) {
  fs.writeFileSync(path.join(location, 'CURRENT'), 'MANIFEST-999999\n')
}

test('open rejects when the database cannot be opened', async function (t) {
  t.plan(5)

  const location = tempy.directory()
  await seed(location)
  corrupt(location)

  const db = new RaveLevel(location, { valueEncoding: 'json' })
  db.on('error', () => t.fail('must not emit error while opening'))

  try {
    await withTimeout(db.open(), 5000, 'open()')
    t.fail('open must reject')
  } catch (err) {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN')
    t.is(err.cause.code, 'LEVEL_IO_ERROR', 'cause is the classic-level error')
  }

  t.is(db.status, 'closed')

  // Operations must not hang: the database is closed
  await withTimeout(db.get('a'), 5000, 'get()').then(() => {
    t.fail('get must reject')
  }, (err) => {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN')
  })

  await db.close()
  t.is(db.status, 'closed')
})

test('operations deferred until open reject when open fails', async function (t) {
  t.plan(2)

  const location = tempy.directory()
  await seed(location)
  corrupt(location)

  const db = new RaveLevel(location, { valueEncoding: 'json' })

  // Issued before open() settled, so it goes through the deferred queue
  const get = withTimeout(db.get('a'), 5000, 'deferred get()').then(() => {
    t.fail('get must reject')
  }, (err) => {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN')
  })

  await withTimeout(db.open(), 5000, 'open()').then(() => {
    t.fail('open must reject')
  }, (err) => {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN')
  })

  await get
})

// This test takes a little over 10 seconds: rave-level keeps retrying for that
// long in case the lock holder is a leader that is still starting up.
test('open rejects when the lock is held by a process that is not a reachable leader', async function (t) {
  t.plan(4)

  const location = tempy.directory()
  await seed(location)

  // Hold the LevelDB lock without exposing a rave-level socket, like a plain
  // classic-level user (or a leader on another machine) would.
  const holder = new ClassicLevel(location, { valueEncoding: 'json' })
  await holder.open()

  const db = new RaveLevel(location, { valueEncoding: 'json' })
  db.on('error', () => t.fail('must not emit error while opening'))

  const start = Date.now()

  try {
    await withTimeout(db.open(), 30000, 'open()')
    t.fail('open must reject')
  } catch (err) {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN')
    t.is(err.cause.code, 'LEVEL_LOCKED', 'cause is the lock error')
  }

  t.ok(Date.now() - start >= 10000, 'retried for the full window before giving up')
  t.is(db.status, 'closed')

  await holder.close()
})
