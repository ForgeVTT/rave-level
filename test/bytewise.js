'use strict'

const test = require('tape')
const bytewise = require('bytewise')
const tempy = require('./util/tempy')
const { RaveLevel } = require('..')

test('bytewise key encoding', async function (t) {
  t.plan(3)

  const location = tempy.directory()
  const db1 = new RaveLevel(location, { keyEncoding: bytewise, valueEncoding: 'json' })
  const db2 = new RaveLevel(location, { keyEncoding: bytewise, valueEncoding: 'json' })
  const value = Math.floor(Math.random() * 100000)

  await db1.put(['a'], value)
  const x = await db2.get(['a'])
  t.is(x, value)

  const db1Entries = await db1.iterator().all()
  t.same(db1Entries, [[['a'], value]], 'a got correct entries')
  const db2Entries = await db2.iterator().all()
  t.same(db2Entries, [[['a'], value]], 'b got correct entries')

  await db1.close()
  await db2.close()
})
