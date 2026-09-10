'use strict'

const { ClassicLevel } = require('classic-level')
const { promises: readableStreamPromises } = require('readable-stream')
const { pipeline } = readableStreamPromises
const { ManyLevelHost, ManyLevelGuest } = require('many-level')
const ModuleError = require('module-error')
const fs = require('fs').promises
const net = require('net')
const path = require('path')
const { createGetSync, registerLeader } = require('./get-sync')

/**
 * Symbol for storing the database location path.
 * @private
 * @type {symbol}
 */
const kLocation = Symbol('location')

/**
 * Symbol for storing the Unix socket path or Windows named pipe path.
 * @private
 * @type {symbol}
 */
const kSocketPath = Symbol('socketPath')

/**
 * Symbol for storing database options like encoding settings.
 * @private
 * @type {symbol}
 */
const kOptions = Symbol('options')

/**
 * Symbol for storing when the current connection attempt started.
 * @private
 * @type {symbol}
 */
const kConnectAttemptStartTime = Symbol('connectAttemptStartTime')

/**
 * Symbol for the internal connect method.
 * @private
 * @type {symbol}
 */
const kConnect = Symbol('connect')

/**
 * Symbol for the internal connection state check.
 * @private
 * @type {symbol}
 */
const kCanConnect = Symbol('canConnect')

/**
 * Symbol for connecting this instance to the current leader.
 * @private
 * @type {symbol}
 */
const kConnectToLeader = Symbol('connectToLeader')

/**
 * Symbol for attempting to open the underlying LevelDB instance as leader.
 * @private
 * @type {symbol}
 */
const kTryOpenLeaderDatabase = Symbol('tryOpenLeaderDatabase')

/**
 * Symbol for turning this instance into the active leader.
 * @private
 * @type {symbol}
 */
const kBecomeLeader = Symbol('becomeLeader')

/**
 * Symbol for removing a stale socket before listening as leader.
 * @private
 * @type {symbol}
 */
const kRemoveStaleSocket = Symbol('removeStaleSocket')

/**
 * Symbol for creating the follower RPC server.
 * @private
 * @type {symbol}
 */
const kCreateServer = Symbol('createServer')

/**
 * Symbol for finalizing leader startup once the socket is listening.
 * @private
 * @type {symbol}
 */
const kOnLeaderListening = Symbol('onLeaderListening')

/**
 * Symbol for flushing pending guest requests after becoming leader.
 * @private
 * @type {symbol}
 */
const kFlushPendingRequests = Symbol('flushPendingRequests')

/**
 * Symbol for the internal destroy method.
 * @private
 * @type {symbol}
 */
const kDestroy = Symbol('destroy')

/**
 * Symbol for reporting a failed connection attempt through the right channel.
 * @private
 * @type {symbol}
 */
const kFail = Symbol('fail')

/**
 * Maximum time (in milliseconds) to retry connecting before giving up.
 * @constant {number}
 * @default
 */
const MAX_CONNECT_RETRY_TIME = 10000 // 10 seconds
const CONNECT_RETRY_DELAY = 100

/**
 * A distributed LevelDB implementation that allows multiple processes to access
 * the same database. Uses a leader-follower model where one process opens the
 * database and acts as the leader, while other processes connect as followers.
 *
 * @class RaveLevel
 * @extends {ManyLevelGuest}
 * @fires RaveLevel#leader
 * @fires RaveLevel#error
 * @fires RaveLevel#flush
 * @example
 * const { RaveLevel } = require('rave-level')
 * const db = new RaveLevel('./my-database', {
 *   keyEncoding: 'utf8',
 *   valueEncoding: 'json'
 * })
 * await db.open()
 * await db.put('key', { value: 'data' })
 */
exports.RaveLevel = class RaveLevel extends ManyLevelGuest {
  /**
   * Creates a new RaveLevel database instance.
   *
   * @param {string} location - The file system path where the database should be stored
   * @param {Object} [options={}] - Configuration options for the database
   * @param {string} [options.keyEncoding] - Encoding to use for keys (e.g., 'utf8', 'buffer')
   * @param {string} [options.valueEncoding] - Encoding to use for values (e.g., 'json', 'utf8')
   * @param {boolean} [options.retry=true] - Whether to retry failed operations
   * @param {string} [options.raveSocketPath] - Custom socket path (defaults to auto-generated path)
   */
  constructor (location, options = {}) {
    const { keyEncoding, valueEncoding, retry } = options
    const resolvedLocation = path.resolve(location)
    const raveSocketPath = options.raveSocketPath || socketPath(resolvedLocation)

    super({
      keyEncoding,
      valueEncoding,
      retry: retry !== false,
      getSync: createGetSync(raveSocketPath)
    })

    this[kLocation] = resolvedLocation
    this[kSocketPath] = raveSocketPath
    this[kOptions] = { keyEncoding, valueEncoding }
    this[kConnectAttemptStartTime] = null

    /**
     * Whether this instance is the leader (has the database lock).
     * @type {boolean}
     */
    this.isLeader = false
  }

  /**
   * Opens the database connection. This is called internally by the database
   * when you call `db.open()`. The method will either connect to an existing
   * leader process or become the leader itself.
   *
   * If neither is possible (the database is corrupt or unreadable, or its lock
   * is held by a process that does not expose a leader socket), the returned
   * promise rejects with the underlying `classic-level` error, so that
   * `db.open()` fails with `LEVEL_DATABASE_NOT_OPEN` and that error as `cause`,
   * exactly like `classic-level` itself would.
   *
   * @private
   * @param {Object} options - Open options passed from the parent class
   * @returns {Promise<void>}
   */
  async _open (options) {
    await super._open(options)
    await this[kConnect]()
  }

  /**
   * Attempts to connect to an existing leader or become the leader.
   * This method will retry multiple times if the database is locked by another
   * process that is still starting up. It returns once this instance either
   * connects to a leader or becomes the leader; callers must invoke it again
   * when a leader connection closes to preserve failover. It throws when the
   * database is still opening and neither is possible (see {@link kFail}).
   *
   * @private
   * @returns {Promise<void>}
   */
  async [kConnect] () {
    // Every attempt, whether the initial open or a failover after the leader
    // went away, gets its own retry window.
    this[kConnectAttemptStartTime] = Date.now()

    while (this[kCanConnect]()) {
      if (await this[kConnectToLeader]()) return

      const { db, retry } = await this[kTryOpenLeaderDatabase]()

      if (db) {
        await this[kBecomeLeader](db)
        return
      }

      if (!retry) return

      await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_DELAY))
    }
  }

  /**
   * Whether this instance is still allowed to connect or become leader.
   *
   * @private
   * @returns {boolean}
   */
  [kCanConnect] () {
    return this.status === 'open' || this.status === 'opening'
  }

  /**
   * Attempts to connect this instance to the current leader process.
   *
   * @private
   * @returns {Promise<boolean>} True if a leader connection was established.
   */
  async [kConnectToLeader] () {
    const socket = net.connect(this[kSocketPath])
    const onerror = () => {}
    socket.on('error', onerror)

    const stream = this.createRpcStream({ ref: socket })
    let connected = false
    let settled = false
    let settle

    const connectedPromise = new Promise(resolve => {
      settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
    })

    const cleanup = () => {
      socket.removeListener('connect', onconnect)
      socket.removeListener('close', onclose)
      socket.removeListener('error', onerror)
    }

    const onconnect = () => {
      connected = true
      settle(true)
    }

    const onclose = () => {
      if (!connected) settle(false)
    }

    socket.once('connect', onconnect)
    socket.once('close', onclose)

    pipeline(socket, stream, socket).catch(() => null).then(() => {
      cleanup()
      if (!connected) settle(false)
      if (connected && this[kCanConnect]()) {
        // The previous leader closed. Reconnect so this instance either follows
        // the new leader or becomes it.
        setImmediate(() => {
          if (this[kCanConnect]()) {
            this[kConnect]().catch(err => this[kDestroy](err))
          }
        })
      }
    })

    return connectedPromise
  }

  /**
   * Attempts to open the underlying LevelDB database as the leader.
   *
   * @private
   * @returns {Promise<{db?: ClassicLevel, retry: boolean}>}
   */
  async [kTryOpenLeaderDatabase] () {
    const db = new ClassicLevel(this[kLocation], this[kOptions])

    // When guest db is closed, close db
    this.attachResource(db)

    try {
      await db.open()
    } catch (err) {
      // Normally called on close but we're throwing db away
      this.detachResource(db)

      // Report the underlying classic-level error (LEVEL_LOCKED, LEVEL_CORRUPTION,
      // LEVEL_IO_ERROR, ...) rather than its generic LEVEL_DATABASE_NOT_OPEN wrapper,
      // so that callers see the same cause they would get from classic-level.
      const cause = err.cause || err

      // If already locked, another process became the leader
      if (cause.code === 'LEVEL_LOCKED') {
        if (Date.now() - this[kConnectAttemptStartTime] <= MAX_CONNECT_RETRY_TIME) {
          return { retry: true }
        }

        // The lock was held for the whole retry window while nobody answered on
        // the socket: whoever holds it is not a leader we can reach. Give up
        // rather than leaving every operation waiting for a leader forever.
      }

      this[kFail](cause)
      return { retry: false }
    }

    return { db, retry: false }
  }

  /**
   * Starts the RPC host and forwards local operations to the leader database.
   *
   * @private
   * @param {ClassicLevel} db - The open database for this leader.
   * @returns {Promise<void>}
   */
  async [kBecomeLeader] (db) {
    if (!this[kCanConnect]()) return

    if (!await this[kRemoveStaleSocket]()) return

    const host = new ManyLevelHost(db)
    const { server, close } = this[kCreateServer](host)
    const unregisterLeader = registerLeader(this[kSocketPath], db)
    const closeLeader = async () => {
      unregisterLeader()
      return close()
    }

    this.attachResource({ close: closeLeader })

    // Bypass socket, so that e.g. this.put() goes directly to db.put()
    // Note: changes order of operations, because we only later flush previous operations (below)
    this.forward(db)

    server.listen(this[kSocketPath], () => this[kOnLeaderListening](server))
  }

  /**
   * Removes the socket left behind by a crashed or exited leader.
   *
   * @private
   * @returns {Promise<boolean>} True if startup can continue.
   */
  async [kRemoveStaleSocket] () {
    try {
      await fs.unlink(this[kSocketPath])
    } catch (err) {
      if (!this[kCanConnect]()) {
        return false
      }

      if (err && err.code !== 'ENOENT') {
        this[kFail](err)
        return false
      }
    }

    return true
  }

  /**
   * Creates the RPC server that followers connect to.
   *
   * @private
   * @param {ManyLevelHost} host - Host wrapping the leader database.
   * @returns {{server: net.Server, close: Function}}
   */
  [kCreateServer] (host) {
    const sockets = new Set()

    /**
     * TCP server that accepts connections from follower processes.
     * Each connection creates an RPC stream that allows followers to
     * communicate with the leader's database.
     *
     * @private
     * @type {net.Server}
     */
    const server = net.createServer(async function (sock) {
      sock.unref()
      sockets.add(sock)
      await pipeline(sock, host.createRpcStream(), sock).catch(() => null)
      sockets.delete(sock)
    })

    const onerror = err => this[kDestroy](err)
    server.on('error', onerror)

    /**
     * Cleanup function that closes all follower connections and shuts down
     * the TCP server. Called when the database is closing.
     *
     * @private
     * @function close
     * @returns {Promise<void>}
     */
    const close = async () => {
      for (const sock of sockets) {
        sock.destroy()
      }

      server.removeListener('error', onerror)
      return server.close()
    }

    return { server, close }
  }

  /**
   * Marks this instance as leader and flushes pending guest requests.
   *
   * @private
   * @param {net.Server} server - The listening follower RPC server.
   * @returns {Promise<void>}
   */
  async [kOnLeaderListening] (server) {
    server.unref()

    if (this.status !== 'open') {
      return
    }

    this.isLeader = true

    /**
     * Leader event.
     * Fired when this instance successfully becomes the database leader.
     *
     * @event RaveLevel#leader
     */
    this.emit('leader')

    if (this.status !== 'open' || this.isFlushed()) {
      return
    }

    await this[kFlushPendingRequests]()
  }

  /**
   * Flushes pending guest requests through the newly-created local leader.
   *
   * @private
   * @returns {Promise<void>}
   */
  async [kFlushPendingRequests] () {
    const sock = net.connect(this[kSocketPath])

    const onflush = () => { sock.destroy() }

    this.once('flush', onflush)

    let cause
    try {
      await pipeline(sock, this.createRpcStream(), sock)
    } catch (err) {
      cause = err
    }
    this.removeListener('flush', onflush)

    // Socket should only close because of a this.close()
    if (!this.isFlushed() && this.status === 'open') {
      this[kDestroy](new ModuleError('Did not flush', { cause }))
    }
  }

  /**
   * Reports a failed attempt to connect to a leader or to open the database.
   *
   * While the database is still opening, the error is thrown so that `open()`
   * rejects and the database ends up closed, with deferred operations rejected
   * (`LEVEL_DATABASE_NOT_OPEN`). Previously the error was silently dropped in
   * that state, which left a database that looked open but on which every
   * operation waited forever for a leader that would never come. Once the
   * database is open (i.e. during failover) the error is emitted as before.
   *
   * @private
   * @param {Error} err - The error that occurred
   * @throws {Error} The same error, if the database is still opening
   * @returns {void}
   */
  [kFail] (err) {
    if (this.status === 'opening') {
      throw err
    }

    this[kDestroy](err)
  }

  /**
   * Handles errors by emitting them on the database instance.
   * This is called when something goes wrong during connection or operation.
   *
   * @private
   * @param {Error} err - The error that occurred
   * @returns {void}
   * @fires RaveLevel#error
   */
  [kDestroy] (err) {
    if (this.status === 'open') {
      /**
       * Error event.
       * Fired when a critical error occurs that prevents normal operation.
       *
       * @todo close?
       * @event RaveLevel#error
       * @type {Error}
       */
      this.emit('error', err)
    }
  }
}

/**
 * Generates the appropriate socket path based on the operating system.
 * On Windows, uses a named pipe. On Unix-like systems, uses a Unix socket file.
 *
 * @private
 * @param {string} location - The database location path
 * @returns {string} The socket path for inter-process communication
 */
/* istanbul ignore next */
const socketPath = function (location) {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\rave-level\\' + location
  } else {
    return path.join(location, 'rave-level.sock')
  }
}
