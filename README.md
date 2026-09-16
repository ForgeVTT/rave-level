# rave-level

**Use a LevelDB database from multiple processes with seamless failover.** Normally with [`classic-level`](https://github.com/Level/classic-level) opening the same location more than once would result in a [`LEVEL_LOCKED`](https://github.com/Level/abstract-level#errors) error. With `rave-level` the first process that succeeds in taking the LevelDB lock becomes the "leader" and creates a [`many-level`](https://github.com/Level/many-level) host to which other processes connect over a unix socket (Linux and Mac) or named pipe (Windows), transparently electing a new leader when it goes down. Pending database operations are then retried and iterators resumed at the last visited key as if nothing happened.

> :pushpin: Which module should I use? What happened to [`level-party`](https://github.com/Level/party)? Head over to the [FAQ](https://github.com/Level/community#faq).

[![level badge][level-badge]](https://github.com/Level/awesome)
[![npm](https://img.shields.io/npm/v/rave-level.svg)](https://www.npmjs.com/package/rave-level)
[![Node version](https://img.shields.io/node/v/rave-level.svg)](https://www.npmjs.com/package/rave-level)
[![Test](https://img.shields.io/github/workflow/status/Level/rave-level/Test?label=test)](https://github.com/Level/rave-level/actions/workflows/test.yml)
[![Coverage](https://img.shields.io/codecov/c/github/Level/rave-level?label=\&logo=codecov\&logoColor=fff)](https://codecov.io/gh/Level/rave-level)
[![Standard](https://img.shields.io/badge/standard-informational?logo=javascript\&logoColor=fff)](https://standardjs.com)
[![Common Changelog](https://common-changelog.org/badge.svg)](https://common-changelog.org)
[![Donate](https://img.shields.io/badge/donate-orange?logo=open-collective\&logoColor=fff)](https://opencollective.com/level)

## Usage

```js
const { RaveLevel } = require('rave-level')
const db = new RaveLevel('./db')
```

## API

### `db = new RaveLevel(location[, options])`

The `location` argument is the same as in [`classic-level`](https://github.com/Level/classic-level), making `rave-level` a drop-in replacement for when you need to read and write to the given `location` from multiple processes simultaneously. However, the `options` are different and limited because not every `RaveLevel` instance has direct access to the underlying LevelDB database. The `options` object may contain:

- `keyEncoding` (string or object, default `'utf8'`): [encoding](https://github.com/Level/abstract-level#encodings) to use for keys
- `valueEncoding` (string or object, default `'utf8'`): encoding to use for values
- `retry` (boolean, default `true`): if true, operations are retried upon connecting to a new leader. This disables [snapshot guarantees](https://github.com/Level/abstract-level#iterator) because retries may implicitly use new snapshots. If false, operations are aborted upon disconnect, which means to yield an error on e.g. `db.get()`.

The `RaveLevel` class extends `AbstractLevel` and thus follows the public API of [`abstract-level`](https://github.com/Level/abstract-level). As such, the rest of the API is documented in `abstract-level`. The database opens itself but (unlike other `abstract-level` implementations) cannot be re-opened once `db.close()` has been called. Calling `db.open()` would then yield a [`LEVEL_NOT_SUPPORTED`](https://github.com/Level/abstract-level#errors) error.

If `rave-level` can neither connect to a leader nor open the database itself, `db.open()` rejects with a [`LEVEL_DATABASE_NOT_OPEN`](https://github.com/Level/abstract-level#errors) error whose `cause` is the underlying `classic-level` error, and pending operations are rejected the same way. This happens when the database is corrupt or unreadable (`LEVEL_CORRUPTION`, `LEVEL_IO_ERROR`, ...) and when the LevelDB lock is held by a process that does not expose a leader socket (`LEVEL_LOCKED`, after retrying for 10 seconds). The latter is what a plain `classic-level` user of the same location looks like to `rave-level`.

### Events

A `RaveLevel` instance will only emit [events](https://github.com/Level/abstract-level#events) that are the result of its own operations (rather than other processes or instances). There's one additional event, emitted when `db` has been elected as the leader:

```js
db.on('leader', function () {
  console.log('I am the leader now')
})
```

## Install

With [npm](https://npmjs.org) do:

```
npm install rave-level
```

## Contributing

[`Level/rave-level`](https://github.com/Level/rave-level) is an **OPEN Open Source Project**. This means that:

> Individuals making significant and valuable contributions are given commit-access to the project to contribute as they see fit. This project is more like an open wiki than a standard guarded open source project.

See the [Contribution Guide](https://github.com/Level/community/blob/master/CONTRIBUTING.md) for more details.

## Donate

Support us with a monthly donation on [Open Collective](https://opencollective.com/level) and help us continue our work.

## License

[MIT](LICENSE)

[level-badge]: https://leveljs.org/img/badge.svg
