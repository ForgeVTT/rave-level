'use strict'

const test = require('tape')
const { once } = require('events')
const tempy = require('./util/tempy')
const { RaveLevel } = require('..')

test('operations queued before leadership complete via self-flush', async function (t) {
  const db = new RaveLevel(tempy.directory())

  // Queue operation before becoming leader
  const putPromise = db.put('abc', 'xyz')

  await once(db, 'leader')

  // The operation should complete (either via flush or forward mechanism)
  await putPromise

  // Verify it was actually written
  t.is(await db.get('abc'), 'xyz', 'queued operation completed and persisted')

  await db.close()
  t.end()
})

test('operations abort when closed before open completes', async function (t) {
  const db = new RaveLevel(tempy.directory())

  // Queue operation and close in same tick, before db opens
  const putPromise = db.put('abc', 'xyz')
  const closePromise = db.close()

  await closePromise

  try {
    await putPromise
    t.fail('put should have been aborted')
  } catch (err) {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN', 'operation aborted with correct error code')
  }

  t.end()
})

test('operations complete when closed after leadership established', async function (t) {
  const db = new RaveLevel(tempy.directory())

  // Queue operation before becoming leader
  const putPromise = db.put('abc', 'xyz')

  // Wait for leadership
  await once(db, 'leader')

  // Close after becoming leader - operation should still complete
  const closePromise = db.close()

  await putPromise
  t.pass('operation completed despite close after leadership')

  await closePromise
  t.end()
})
