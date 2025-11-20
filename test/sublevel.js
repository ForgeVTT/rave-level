'use strict'

const test = require('tape')
const tempy = require('./util/tempy')
const { RaveLevel } = require('..')

// TODO: rewrite using async instead of callbacks
test('sublevel', async function (t) {
  t.plan(4)

  const location = tempy.directory()
  const db1 = new RaveLevel(location)
  const db2 = new RaveLevel(location)
  const sub1 = db1.sublevel('test', { valueEncoding: 'json' })
  const sub2 = db2.sublevel('test')
  const obj = { test: Math.floor(Math.random() * 100000) }

  await sub1.put('a', obj).catch(t.ifError)

  const value1 = await sub1.get('a').catch(t.ifError)
  t.same(value1, obj)

  const value2 = await sub2.get('a').catch(t.ifError)
  t.same(value2, JSON.stringify(obj))

  const iteratorEntries1 = await sub1.iterator().all().catch(t.ifError)
  t.same(iteratorEntries1, [['a', obj]])

  const iteratorEntries2 = await sub2.iterator().all().catch(t.ifError)
  t.same(iteratorEntries2, [['a', JSON.stringify(obj)]])

  t.on('end', async () => {
    await db1.close()
    await db2.close()
  })
})
