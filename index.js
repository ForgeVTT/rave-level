'use strict'

const { ClassicLevel } = require('classic-level')
const { promises: readableStreamPromises } = require('readable-stream')
const { pipeline } = readableStreamPromises
const { ManyLevelHost, ManyLevelGuest } = require('many-level')
const ModuleError = require('module-error')
const fs = require('fs').promises
const net = require('net')
const path = require('path')

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
 * Symbol for the internal connect method.
 * @private
 * @type {symbol}
 */
const kConnect = Symbol('connect')

/**
 * Symbol for the internal destroy method.
 * @private
 * @type {symbol}
 */
const kDestroy = Symbol('destroy')

/**
 * Maximum time (in milliseconds) to retry connecting before giving up.
 * @constant {number}
 * @default
 */
const MAX_CONNECT_RETRY_TIME = 10000 // 10 seconds

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

    super({
      keyEncoding,
      valueEncoding,
      retry: retry !== false
    })

    this[kLocation] = path.resolve(location)
    this[kSocketPath] = options.raveSocketPath || socketPath(this[kLocation])
    this[kOptions] = { keyEncoding, valueEncoding }
    this[kConnect] = this[kConnect].bind(this)
    this[kDestroy] = this[kDestroy].bind(this)

    /**
     * Timestamp when the current connection attempt started.
     * Used to track retry timeouts.
     * @type {number|null}
     */
    this.connectAttemptStartTime = null

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
   * @private
   * @param {Object} options - Open options passed from the parent class
   * @returns {Promise<void>}
   */
  async _open (options) {
    await super._open(options)
    return new Promise((resolve, reject) => {
      // Pass resolve & reject to kConnect so that it can let _open finish when needed
      this[kConnect](resolve, reject).then(resolve)
    })
  }

  /**
   * Attempts to connect to an existing leader or become the leader.
   * This method will retry multiple times if the database is locked by another
   * process that is still starting up.
   *
   * @private
   * @param {Function} [resolve] - Promise resolve function from _open
   * @param {Function} [reject] - Promise reject function from _open
   * @returns {Promise<void>}
   */
  async [kConnect] (resolve, reject) {
    if (!this.connectAttemptStartTime) this.connectAttemptStartTime = Date.now()

    // Monitor database state and do not proceed to open if in a non-opening state
    if (!['open', 'opening'].includes(this.status)) {
      return
    }

    // Attempt to connect to leader as follower
    const socket = net.connect(this[kSocketPath])

    // Track whether we succeeded to connect
    let connected = false

    /**
     * Callback fired when socket successfully connects to a leader.
     * Resolves the _open promise to allow the database to finish opening.
     *
     * @private
     * @function onconnect
     * @returns {void}
     */
    const onconnect = () => {
      connected = true
      // If we manage to connect to an existing host, [kConnect] will be waiting in the pipeline
      // call below. We need to resolve the promise here, so that _open can finish.
      if (resolve) resolve()
      resolve = reject = null
    }
    const onclose = () => {
      connected = false
      this.connectAttemptStartTime = null
      // Disconnected. Cleanup events.
      socket.removeListener('connect', onconnect)
      socket.removeListener('close', onclose)
    }
    socket.once('connect', onconnect)
    socket.once('close', onclose)

    // Pass socket as the ref option so we don't hang the event loop.
    await pipeline(socket, this.createRpcStream({ ref: socket }), socket).catch(() => null)
    // Disconnected. Cleanup events.
    socket.removeListener('connect', onconnect)
    socket.removeListener('close', onclose)

    // Monitor database state and do not proceed to open if in a non-opening state
    if (!['open', 'opening'].includes(this.status)) {
      return
    }

    // We are still trying to open the db the first time and there is no leader yet to connect to.
    // Attempt to open db as leader
    const db = new ClassicLevel(this[kLocation], this[kOptions])

    // When guest db is closed, close db
    this.attachResource(db)
    try {
      await db.open()
    } catch (err) {
      // Normally called on close but we're throwing db away
      this.detachResource(db)

      // If already locked, another process became the leader
      if (err.cause && err.cause.code === 'LEVEL_LOCKED') {
        // If we've been retrying for too long, abort.
        if (this.connectAttemptStartTime && (Date.now() - this.connectAttemptStartTime > MAX_CONNECT_RETRY_TIME)) {
          return this[kDestroy](err)
        }
        if (connected) {
          return this[kConnect](resolve, reject)
        } else {
          // Wait for a short delay
          await new Promise((resolve) => setTimeout(resolve, 100))
          // Call connect again
          return this[kConnect](resolve, reject)
        }
      } else {
        return this[kDestroy](err)
      }
    }

    if (!['open', 'opening'].includes(this.status)) {
      return
    }

    // We're the leader now
    try {
      await fs.unlink(this[kSocketPath])
    } catch (err) {
      if (!['open', 'opening'].includes(this.status)) {
        return
      }

      if (err && err.code !== 'ENOENT') {
        return this[kDestroy](err)
      }
    }

    // Create host to expose db
    const host = new ManyLevelHost(db)
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

    server.on('error', this[kDestroy])

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

      server.removeListener('error', this[kDestroy])
      return server.close()
    }

    // When guest db is closed, close server
    this.attachResource({ close })

    // Bypass socket, so that e.g. this.put() goes directly to db.put()
    // Note: changes order of operations, because we only later flush previous operations (below)
    this.forward(db)

    server.listen(this[kSocketPath], async () => {
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

      // Connect to ourselves to flush pending requests
      const sock = net.connect(this[kSocketPath])

      /**
       * Callback that destroys the flush socket when all pending
       * operations have been processed.
       *
       * @private
       * @function onflush
       * @returns {void}
       */
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
    })
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
