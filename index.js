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

    super({
      keyEncoding,
      valueEncoding,
      retry: retry !== false
    })

    this._location = path.resolve(location)
    this._socketPath = options.raveSocketPath || socketPath(this._location)
    this._options = { keyEncoding, valueEncoding }
    this._connectAttemptStartTime = null

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
    await this._connect()
  }

  /**
   * Attempts to connect to an existing leader or become the leader.
   * This method will retry multiple times if the database is locked by another
   * process that is still starting up.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _connect () {
    if (!this._connectAttemptStartTime) this._connectAttemptStartTime = Date.now()

    while (this._canConnect()) {
      if (await this._connectToLeader()) return

      const { db, retry } = await this._tryOpenLeaderDatabase()

      if (db) {
        await this._becomeLeader(db)
        return
      }

      if (!retry) return

      await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_DELAY))
    }
  }

  _canConnect () {
    return this.status === 'open' || this.status === 'opening'
  }

  async _connectToLeader () {
    const socket = net.connect(this._socketPath)
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
      this._connectAttemptStartTime = null
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
      if (connected && this._canConnect()) {
        setImmediate(() => {
          if (this._canConnect()) {
            this._connect().catch(err => this._destroy(err))
          }
        })
      }
    })

    return connectedPromise
  }

  async _tryOpenLeaderDatabase () {
    const db = new ClassicLevel(this._location, this._options)

    // When guest db is closed, close db
    this.attachResource(db)

    try {
      await db.open()
    } catch (err) {
      // Normally called on close but we're throwing db away
      this.detachResource(db)

      // If already locked, another process became the leader
      if (err.cause && err.cause.code === 'LEVEL_LOCKED') {
        if (this._connectAttemptStartTime && (Date.now() - this._connectAttemptStartTime > MAX_CONNECT_RETRY_TIME)) {
          this._destroy(err)
          return { retry: false }
        }

        return { retry: true }
      }

      this._destroy(err)
      return { retry: false }
    }

    return { db, retry: false }
  }

  async _becomeLeader (db) {
    if (!this._canConnect()) return

    if (!await this._removeStaleSocket()) return

    const host = new ManyLevelHost(db)
    const { server, close } = this._createServer(host)

    this.attachResource({ close })

    // Bypass socket, so that e.g. this.put() goes directly to db.put()
    // Note: changes order of operations, because we only later flush previous operations (below)
    this.forward(db)

    server.listen(this._socketPath, () => this._onLeaderListening(server))
  }

  async _removeStaleSocket () {
    try {
      await fs.unlink(this._socketPath)
    } catch (err) {
      if (!this._canConnect()) {
        return false
      }

      if (err && err.code !== 'ENOENT') {
        this._destroy(err)
        return false
      }
    }

    return true
  }

  _createServer (host) {
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

    const onerror = err => this._destroy(err)
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

  async _onLeaderListening (server) {
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

    await this._flushPendingRequests()
  }

  async _flushPendingRequests () {
    const sock = net.connect(this._socketPath)

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
      this._destroy(new ModuleError('Did not flush', { cause }))
    }
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
  _destroy (err) {
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
