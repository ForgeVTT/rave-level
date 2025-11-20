'use strict'

const test = require('tape')
const { once } = require('events')
const tempy = require('./util/tempy')
const { RaveLevel } = require('..')

test('basic failover', async function (t) {
  const location = tempy.directory()
  const db1 = new RaveLevel(location)
  await once(db1, 'leader')

  const db2 = new RaveLevel(location)
  const values = new Array(100).fill(0).map((_, i) => String(i))
  const promises = values.map(v => db2.put(v.padStart(3, '0'), v))

  await Promise.all([db1.close(), once(db2, 'leader'), ...promises])

  t.same(await db2.values().all(), values)
})

test('failover election party', async function (t) {
  const location = tempy.directory()
  const keys = ['a', 'b', 'c', 'e', 'f', 'g']
  const len = keys.length
  // Assertion count: 6+5+4+3+2+1 = 21 total (one per database per iteration)
  t.plan(len * (len + 1) / 2)

  const databases = {}

  // Open all databases and wait for them to be ready
  await Promise.all(
    keys.map(key => {
      const db = new RaveLevel(location, { valueEncoding: 'json' })
      databases[key] = db

      // Wrap the 'open' event in a promise so we can await it
      return new Promise((resolve, reject) => {
        db.on('open', resolve)
        db.on('error', reject)
      })
    })
  )

  // Test sequential failover: close databases one at a time while
  // validating that remaining databases still replicate correctly
  const alive = keys.slice() // Copy so we can mutate without affecting original

  while (alive.length > 0) {
    // Validate circular replication across all remaining databases
    // Each database writes a value that the next database should be able to read
    for (let i = 0; i < alive.length; i++) {
      const currentKey = alive[i]
      const nextKey = alive[(i + 1) % alive.length] // Wrap around to first database
      const value = Math.random()

      // Write to current database
      await databases[currentKey].put(currentKey, value)

      // Give the updated value a chance to propagate
      await new Promise(resolve => setTimeout(resolve, 1))

      // Read from next database (should be replicated)
      const retrieved = await databases[nextKey].get(currentKey)

      // Verify the replicated value matches what we wrote
      t.equal(retrieved, value)
    }

    // Remove and close the first database in the remaining set
    const key = alive.shift()
    await databases[key].close()
  }
})
