'use strict'

const test = require('tape')
const tempy = require('./util/tempy')
const { fork } = require('child_process')
const { RaveLevel } = require('..')

// The tests below run this file multiple times as separate processes.
// The forked processes have the 'child' argument, so they run this code.
if (process.argv[2] === 'child') {
  (async () => {
    const [location, key, value, expectedCount] = process.argv.slice(3)
    const db = new RaveLevel(location)

    try {
      // Step 1: Write our key-value pair
      await db.put(key, value)

      // Step 2: Wait 1 second for other processes to complete their writes
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Step 3: Verify we can read back our own value
      const retrieved = await db.get(key)
      const retrievalSuccess = retrieved === value

      // Step 4: Count all entries in the database
      const entries = await db.iterator().all()
      const actualCount = entries.length
      const countCorrect = actualCount === parseInt(expectedCount, 10)

      // Send detailed results back to parent via IPC
      process.send({
        success: retrievalSuccess && countCorrect,
        key,
        expectedValue: value,
        retrievedValue: retrieved,
        retrievalSuccess,
        expectedCount: parseInt(expectedCount, 10),
        actualCount,
        countCorrect,
        observedKeys: entries.map(([k]) => k)
      })

      // Exit cleanly
      process.exit(0)
    } catch (err) {
      // Send error information back to parent
      process.send({
        success: false,
        key,
        error: err.message,
        stack: err.stack
      })
      process.exit(1)
    }
  })()
} else {
  // This is the logic run by the test runner, since it does not provide
  // the 'child' argument to this file.
  // Repeat because we have/had random issues here
  for (let i = 0; i < 20; i++) {
    test(`multiple processes (${i})`, async function (t) {
      const location = tempy.directory()
      const entries = []
      const processCount = 10
      const childProcesses = []

      /**
       * Spawns a child process and collects both its exit status and IPC messages
       *
       * @param {string[]} argv - Arguments to pass to the child process
       * @returns {Promise<{exitCode: number, signal: string|null, result: object}>}
       */
      const spawnAndCollect = (argv) => {
        return new Promise((resolve, reject) => {
          const child = fork(__filename, argv, { timeout: 30e3 })
          let result = null

          // Collect the IPC message from the child
          child.on('message', (msg) => {
            result = msg
          })

          // Wait for the child to exit
          child.on('exit', (code, signal) => {
            resolve({
              exitCode: code,
              signal,
              result
            })
          })

          child.on('error', (err) => {
            reject(err)
          })
        })
      }

      // Spawn all child processes
      for (let i = 0; i < processCount; i++) {
        const key = String(i).padStart(5, '0')
        const value = String(Math.random())
        const argv = ['child', location, key, value, String(processCount)]

        entries.push([key, value])
        childProcesses.push(spawnAndCollect(argv))
      }

      // Wait for all children to complete
      const results = await Promise.all(childProcesses)

      // Validate each child's results
      let allSucceeded = true

      for (let i = 0; i < results.length; i++) {
        const { exitCode, signal, result } = results[i]
        const expectedKey = entries[i][0]
        const expectedValue = entries[i][1]

        // Check if we received a result message
        if (!result) {
          t.fail(`Process for key ${expectedKey} did not send result message`)
          allSucceeded = false
          continue
        }

        // Check for errors
        if (result.error) {
          t.fail(`Process for key ${expectedKey} encountered error: ${result.error}`)
          allSucceeded = false
          continue
        }

        // Validate exit status
        if (exitCode !== 0 || signal !== null) {
          t.fail(`Process for key ${expectedKey} exited abnormally: code=${exitCode}, signal=${signal}`)
          allSucceeded = false
        }

        // Validate retrieval
        if (!result.retrievalSuccess) {
          t.fail(`Process for key ${expectedKey} failed retrieval check: expected="${expectedValue}", got="${result.retrievedValue}"`)
          allSucceeded = false
        }

        // Validate count
        if (!result.countCorrect) {
          t.fail(`Process for key ${expectedKey} observed wrong count: expected=${result.expectedCount}, actual=${result.actualCount}`)
          t.comment(`  Observed keys: ${result.observedKeys.join(', ')}`)
          allSucceeded = false
        }

        // Individual success check
        t.ok(result.success, `Process for key ${expectedKey} completed all validations`)
      }

      // Overall success assertion
      t.ok(allSucceeded, 'All child processes completed successfully with correct validations')

      // Final verification: read all entries from parent process
      const finalEntries = await new RaveLevel(location).iterator().all()
      t.same(finalEntries, entries, 'All entries present and in expected order')
    })
  }
}
