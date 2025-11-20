'use strict'

const test = require('tape')
const tempy = require('./util/tempy')
const { fork } = require('child_process')
const { RaveLevel } = require('..')

/**
 * Child process logic for cross-process failover testing.
 *
 * This process:
 * 1. Opens a database at a shared location
 * 2. Writes its own key-value pair
 * 3. Waits a staggered amount of time based on its process index
 * 4. Reads back its own value to verify the write succeeded
 * 5. Counts all entries in the database via iterator
 * 6. Reports results back to parent via IPC
 * 7. Closes the database and exits
 *
 * The staggered timing ensures processes terminate in sequence,
 * forcing leadership transitions and testing that later processes
 * can continue operating after earlier processes (including the
 * original leader) have terminated.
 */
if (process.argv[2] === 'child') {
  (async () => {
    const [location, key, value, processIndex] = process.argv.slice(3)
    const db = new RaveLevel(location)

    // Track whether this process believes it's the leader
    let isLeader = false
    db.on('leader', () => {
      isLeader = true
    })

    try {
      // Step 1: Write our key-value pair
      await db.put(key, value)

      // Step 2: Wait a staggered amount of time
      // Process 0 waits 1.0s, process 1 waits 1.1s, etc.
      // This ensures processes exit in sequence, triggering failover
      const waitTime = 1000 + (parseInt(processIndex, 10) * 100)
      await new Promise(resolve => setTimeout(resolve, waitTime))

      // Step 3: Verify we can read back our own value
      // This validates that our write persisted and we can read after
      // potential leadership changes
      const retrieved = await db.get(key)
      const retrievalSuccess = retrieved === value

      // Step 4: Count all entries in the database
      // Earlier processes will see fewer entries (they exit before
      // later processes finish writing). Later processes should see
      // more entries, validating that leadership transitions don't
      // prevent new writes from being visible.
      const entries = await db.iterator().all()
      const actualCount = entries.length

      // Step 5: Send detailed results back to parent via IPC
      process.send({
        success: retrievalSuccess,
        key,
        processIndex: parseInt(processIndex, 10),
        expectedValue: value,
        retrievedValue: retrieved,
        retrievalSuccess,
        actualCount,
        observedKeys: entries.map(([k]) => k),
        wasLeader: isLeader,
        waitTime
      })

      // Step 6: Close database and exit cleanly
      await db.close()
      process.exit(0)
    } catch (err) {
      // Send error information back to parent
      process.send({
        success: false,
        key,
        processIndex: parseInt(processIndex, 10),
        error: err.message,
        stack: err.stack
      })
      process.exit(1)
    }
  })()
} else {
  // Test runner logic - spawns multiple child processes and validates failover

  /**
   * Spawns a child process and collects both its exit status and IPC messages.
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

  // Repeat because we have/had random issues here
  for (let i = 0; i < 20; i++) {
    test(`cross-process failover (${i})`, async function (t) {
      const location = tempy.directory()
      const entries = []
      const processCount = 10
      const childProcesses = []

      // Spawn all child processes with staggered exit times
      for (let i = 0; i < processCount; i++) {
        const key = String(i).padStart(5, '0')
        const value = String(Math.random())
        const argv = [
          'child',
          location,
          key,
          value,
          String(i) // processIndex
        ]

        entries.push([key, value])
        childProcesses.push(spawnAndCollect(argv))
      }

      // Wait for all children to complete
      const results = await Promise.all(childProcesses)

      // Track overall test success
      let allSucceeded = true
      const resultsByIndex = results.slice().sort((a, b) => {
        return (a.result?.processIndex || 0) - (b.result?.processIndex || 0)
      })

      // Validate each child's results
      for (let j = 0; j < resultsByIndex.length; j++) {
        const { exitCode, signal, result } = resultsByIndex[j]
        const expectedKey = entries[j][0]
        const expectedValue = entries[j][1]

        // Check if we received a result message
        if (!result) {
          t.fail(`Process ${i}-${j} (key ${expectedKey}) did not send result message`)
          allSucceeded = false
          continue
        }

        // Check for errors
        if (result.error) {
          t.fail(`Process ${i}-${j} (key ${expectedKey}) encountered error: ${result.error}`)
          allSucceeded = false
          continue
        }

        // Validate exit status
        if (exitCode !== 0 || signal !== null) {
          t.fail(`Process ${i}-${j} (key ${expectedKey}) exited abnormally: code=${exitCode}, signal=${signal}`)
          allSucceeded = false
        }

        // Validate retrieval - every process should be able to read its own value
        // This is critical: even after leadership changes, a process must be able
        // to read data it wrote
        if (!result.retrievalSuccess) {
          t.fail(`Process ${i}-${j} (key ${expectedKey}) failed to retrieve its own value: expected="${expectedValue}", got="${result.retrievedValue}"`)
          allSucceeded = false
        } else {
          t.pass(`Process ${i}-${j} (key ${expectedKey}) successfully retrieved its own value after ${result.waitTime}ms`)
        }

        // Validate count is reasonable
        // Early processes (e.g., process 0) might only see 1-3 entries because
        // they exit before later processes finish writing.
        // Later processes should see more entries.
        if (result.actualCount < 1) {
          t.fail(`Process ${i}-${j} (key ${expectedKey}) observed no entries (expected at least 1)`)
          allSucceeded = false
        } else if (result.actualCount > processCount) {
          t.fail(`Process ${i}-${j} (key ${expectedKey}) observed too many entries: ${result.actualCount} > ${processCount}`)
          allSucceeded = false
        } else {
          t.pass(`Process ${i}-${j} (key ${expectedKey}) observed ${result.actualCount} entries (reasonable)`)
        }

        // Log whether this process was ever the leader
        if (result.wasLeader) {
          t.comment(`  Process ${i}-${j} (key ${expectedKey}) served as leader`)
        }
      }

      // Overall success assertion
      t.ok(allSucceeded, `Iteration ${i} | All child processes completed successfully with correct validations`)

      // CRITICAL VALIDATION: Final verification from parent process
      // After all processes have terminated (including multiple leadership
      // transitions), the database must still contain all 10 entries.
      // This proves that:
      // 1. Leadership transitions didn't cause data loss
      // 2. All writes were successfully persisted
      // 3. The final leader correctly maintained all data
      const db = new RaveLevel(location)
      const finalEntries = await db.iterator().all()

      t.equal(
        finalEntries.length,
        processCount,
        `Iteration ${i} | Database contains exactly ${processCount} entries after all processes terminated`
      )

      t.same(
        finalEntries,
        entries,
        `Iteration ${i} | All entries present in correct order after cross-process failover`
      )

      await db.close()
    })
  }
}
