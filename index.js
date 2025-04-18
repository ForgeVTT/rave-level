'use strict'

const { ClassicLevel } = require('classic-level')
const { promises: readableStreamPromises } = require('readable-stream')
const { pipeline } = readableStreamPromises
const { ManyLevelHost, ManyLevelGuest } = require('many-level')
const ModuleError = require('module-error')
const fs = require('fs').promises
const net = require('net')
const path = require('path')

const kLocation = Symbol('location')
const kSocketPath = Symbol('socketPath')
const kOptions = Symbol('options')
const kConnect = Symbol('connect')
const kDestroy = Symbol('destroy')

const MAX_CONNECT_RETRY_TIME = 10000 // 10 seconds

exports.RaveLevel = class RaveLevel extends ManyLevelGuest {
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
    this.connectAttemptStartTime = null
    this.isLeader = false
  }

  async _open (options) {
    await super._open(options)
    return new Promise((resolve, reject) => {
      // Pass resolve & reject to kConnect so that it can let _open finish when needed
      this[kConnect](resolve, reject).then(resolve)
    })
  }

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
    const onconnect = () => {
      connected = true
      // If we manage to connect to an existing host, [kConnect] will be waiting in the pipeline
      // call below. We need to resolve the promise here, so that _open can finish.
      if (resolve) resolve()
      resolve = reject = null
    }
    socket.once('connect', onconnect)

    // Pass socket as the ref option so we don't hang the event loop.
    await pipeline(socket, this.createRpcStream({ ref: socket }), socket).catch(() => null)
    // Disconnected. Cleanup events.
    socket.removeListener('connect', onconnect)

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
        if (Date.now() - this.connectAttemptStartTime > MAX_CONNECT_RETRY_TIME) {
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

    // Start server for followers
    const server = net.createServer(async function (sock) {
      sock.unref()
      sockets.add(sock)
      await pipeline(sock, host.createRpcStream(), sock).catch(() => null)
      sockets.delete(sock)
    })

    server.on('error', this[kDestroy])

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
      this.emit('leader')

      if (this.status !== 'open' || this.isFlushed()) {
        return
      }

      // Connect to ourselves to flush pending requests
      const sock = net.connect(this[kSocketPath])
      const onflush = () => { sock.destroy() }

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

      this.once('flush', onflush)
    })
  }

  [kDestroy] (err) {
    if (this.status === 'open') {
      // TODO: close?
      this.emit('error', err)
    }
  }
}

/* istanbul ignore next */
const socketPath = function (location) {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\rave-level\\' + location
  } else {
    return path.join(location, 'rave-level.sock')
  }
}
