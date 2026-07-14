import {
  AbstractLevel,
  AbstractDatabaseOptions,
  AbstractOpenOptions,
  AbstractGetOptions,
  AbstractGetManyOptions,
  AbstractHasOptions,
  AbstractHasManyOptions,
  AbstractPutOptions,
  AbstractDelOptions,
  AbstractBatchOperation,
  AbstractBatchOptions,
  AbstractChainedBatch,
  AbstractChainedBatchWriteOptions,
  AbstractIteratorOptions,
  AbstractIterator,
  AbstractKeyIterator,
  AbstractKeyIteratorOptions,
  AbstractValueIterator,
  AbstractValueIteratorOptions,
  AbstractSnapshot
} from 'abstract-level'

/**
 * Use a [LevelDB](https://github.com/google/leveldb) database from multiple processes
 * with seamless failover.
 *
 * @template KDefault The default type of keys if not overridden on operations.
 * @template VDefault The default type of values if not overridden on operations.
 */
export class RaveLevel<KDefault = string, VDefault = string>
  extends AbstractLevel<string | Buffer | Uint8Array, KDefault, VDefault> {
  /**
   * Database constructor.
   *
   * @param location Directory path (relative or absolute) where LevelDB will
   * store its files.
   * @param options Options.
   */
  constructor (
    location: string,
    options?: DatabaseOptions<KDefault, VDefault> | undefined
  )

  /**
   * Whether this instance is the leader process for the database.
   */
  isLeader: boolean

  open (): Promise<void>
  open (options: OpenOptions): Promise<void>

  get (key: KDefault): Promise<VDefault | undefined>
  get<K = KDefault, V = VDefault> (key: K, options: GetOptions<K, V>): Promise<V | undefined>

  getSync (key: KDefault): VDefault | undefined
  getSync<K = KDefault, V = VDefault> (key: K, options: GetOptions<K, V>): V | undefined

  getMany (keys: KDefault[]): Promise<Array<VDefault | undefined>>
  getMany<K = KDefault, V = VDefault> (keys: K[], options: GetManyOptions<K, V>): Promise<Array<V | undefined>>

  has (key: KDefault): Promise<boolean>
  has<K = KDefault> (key: K, options: HasOptions<K>): Promise<boolean>

  hasMany (keys: KDefault[]): Promise<boolean[]>
  hasMany<K = KDefault> (keys: K[], options: HasManyOptions<K>): Promise<boolean[]>

  put (key: KDefault, value: VDefault): Promise<void>
  put<K = KDefault, V = VDefault> (key: K, value: V, options: PutOptions<K, V>): Promise<void>

  del (key: KDefault): Promise<void>
  del<K = KDefault> (key: K, options: DelOptions<K>): Promise<void>

  batch (operations: Array<BatchOperation<typeof this, KDefault, VDefault>>): Promise<void>
  batch<K = KDefault, V = VDefault> (operations: Array<BatchOperation<typeof this, K, V>>, options: BatchOptions<K, V>): Promise<void>
  batch (): ChainedBatch<typeof this, KDefault, VDefault>

  iterator (): Iterator<typeof this, KDefault, VDefault>
  iterator<K = KDefault, V = VDefault> (options: IteratorOptions<K, V>): Iterator<typeof this, K, V>

  keys (): KeyIterator<typeof this, KDefault>
  keys<K = KDefault> (options: KeyIteratorOptions<K>): KeyIterator<typeof this, K>

  values (): ValueIterator<typeof this, KDefault, VDefault>
  values<K = KDefault, V = VDefault> (options: ValueIteratorOptions<K, V>): ValueIterator<typeof this, K, V>

  snapshot (options?: any | undefined): Snapshot
}

/**
 * Options for the {@link RaveLevel} constructor.
 */
export interface DatabaseOptions<K, V> extends
  Omit<AbstractDatabaseOptions<K, V>, 'createIfMissing' | 'errorIfExists'> {
  /**
   * If true, operations are retried upon connecting to a new leader. If false,
   * operations are aborted upon disconnect, which means to yield an error on e.g.
   * `db.get()`.
   *
   * @defaultValue `true`
   */
  retry?: boolean

  /**
   * Custom socket path used for follower connections.
   */
  raveSocketPath?: string | undefined
}

export type OpenOptions = AbstractOpenOptions
export type GetOptions<K, V> = AbstractGetOptions<K, V>
export type GetManyOptions<K, V> = AbstractGetManyOptions<K, V>
export type HasOptions<K> = AbstractHasOptions<K>
export type HasManyOptions<K> = AbstractHasManyOptions<K>
export type PutOptions<K, V> = AbstractPutOptions<K, V>
export type DelOptions<K> = AbstractDelOptions<K>
export type BatchOptions<K, V> = AbstractBatchOptions<K, V>
export type ChainedBatchWriteOptions = AbstractChainedBatchWriteOptions

export type BatchOperation<TDatabase, K, V> = AbstractBatchOperation<TDatabase, K, V>
export type ChainedBatch<TDatabase, K, V> = AbstractChainedBatch<TDatabase, K, V>
export type Iterator<TDatabase, K, V> = AbstractIterator<TDatabase, K, V>
export type KeyIterator<TDatabase, K> = AbstractKeyIterator<TDatabase, K>
export type ValueIterator<TDatabase, K, V> = AbstractValueIterator<TDatabase, K, V>

export type IteratorOptions<K, V> = AbstractIteratorOptions<K, V>
export type KeyIteratorOptions<K> = AbstractKeyIteratorOptions<K>
export type ValueIteratorOptions<K, V> = AbstractValueIteratorOptions<K, V>

export type Snapshot = AbstractSnapshot
