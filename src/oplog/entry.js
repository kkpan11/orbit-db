import Clock from './clock.js'
import * as Block from 'multiformats/block'
import * as dagCbor from '@ipld/dag-cbor'
import { sha256 } from 'multiformats/hashes/sha2'
import { base58btc } from 'multiformats/bases/base58'

const codec = dagCbor
const hasher = sha256
const hashStringEncoding = base58btc

/**
 * @typedef {Object} module:Log~Entry
 * @property {string} id A string linking multiple entries together.
 * @property {*} payload An arbitrary chunk of data.
 * @property {Array<string>} next One or more hashes pointing to the next entries in a chain of
 * entries.
 * @property {Array<string>} refs One or more hashes which reference other entries in the chain.
 * @property {Clock} clock A logical clock. See {@link module:Log~Clock}.
 * @property {integer} v The version of the entry.
 * @property {string} key The public key of the identity.
 * @property {string} identity The identity of the entry's owner.
 * @property {string} sig The signature of the entry signed by the owner.
 */

/**
 * Creates an Entry.
 * @param {module:Identities~Identity} identity The identity instance
 * @param {string} logId The unique identifier for this log
 * @param {*} data Data of the entry to be added. Can be any JSON.stringifyable
 * data.
 * @param {module:Log~Clock} [clock] The clock
 * @param {Array<string|Entry>} [next=[]] An array of CIDs as base58btc encoded
 * strings which point to the next entries in a chain of entries.
 * @param {Array<string|module:Log~Entry>} [refs=[]] An array of CIDs as
 * base58btc encoded strings pointing to various entries which come before
 * this entry.
 * @return {Promise<module:Log~Entry>} A promise which contains an instance of
 * Entry.
 * Entry consists of the following properties:
 *
 * - id: A string linking multiple entries together,
 * - payload: An arbitrary chunk of data,
 * - next: One or more hashes pointing to the next entries in a chain of
 * entries,
 * - refs: One or more hashes which reference other entries in the chain,
 * - clock: A logical clock. See {@link module:Log~Clock},
 * - v: The version of the entry,
 * - key: The public key of the identity,
 * - identity: The identity of the entry's owner,
 * - sig: The signature of the entry signed by the owner.
 * @memberof module:Log~Entry
 * @example
 * const entry = await Entry.create(identity, 'log1', 'hello')
 * console.log(entry)
 * // { payload: "hello", next: [], ... }
 * @private
 */
const create = async (identity, id, payload, encryptPayloadFn, clock = null, next = [], refs = []) => {
  if (identity == null) throw new Error('Identity is required, cannot create entry')
  if (id == null) throw new Error('Entry requires an id')
  if (payload == null) throw new Error('Entry requires a payload')
  if (next == null || !Array.isArray(next)) throw new Error("'next' argument is not an array")

  clock = clock || Clock(identity.publicKey)

  let encryptedPayload

  if (encryptPayloadFn) {
    const { bytes: encodedPayloadBytes } = await Block.encode({ value: payload, codec, hasher })
    encryptedPayload = await encryptPayloadFn(encodedPayloadBytes)
  }

  const entry = {
    id, // For determining a unique chain
    payload: encryptedPayload || payload, // Can be any dag-cbor encodeable data
    next, // Array of strings of CIDs
    refs, // Array of strings of CIDs
    clock, // Clock
    v: 2 // To tag the version of this data structure
  }

  const { bytes } = await Block.encode({ value: entry, codec, hasher })
  const signature = await identity.sign(identity, bytes)

  entry.key = identity.publicKey
  entry.identity = identity.hash
  entry.sig = signature
  entry.payload = payload

  if (encryptPayloadFn) {
    entry._payload = encryptedPayload
  }

  return entry
}

/**
 * Verifies an entry signature.
 * @param {Identities} identities Identities system to use
 * @param {module:Log~Entry} entry The entry being verified
 * @return {Promise<boolean>} A promise that resolves to a boolean value indicating if
 * the signature is valid.
 * @memberof module:Log~Entry
 * @private
 */
const verify = async (identities, entry) => {
  if (!identities) throw new Error('Identities is required, cannot verify entry')
  if (!isEntry(entry)) throw new Error('Invalid Log entry')
  if (!entry.key) throw new Error("Entry doesn't have a key")
  if (!entry.sig) throw new Error("Entry doesn't have a signature")

  const e = Object.assign({}, entry)

  const value = {
    id: e.id,
    payload: e._payload || e.payload,
    next: e.next,
    refs: e.refs,
    clock: e.clock,
    v: e.v
  }

  const { bytes } = await Block.encode({ value, codec, hasher })

  return identities.verify(entry.sig, entry.key, bytes)
}

/**
 * Checks if an object is an Entry.
 * @param {module:Log~Entry} obj
 * @return {boolean}
 * @memberof module:Log~Entry
 * @private
 */
const isEntry = (obj) => {
  return obj && obj.id !== undefined &&
    obj.next !== undefined &&
    obj.payload !== undefined &&
    obj.v !== undefined &&
    obj.clock !== undefined &&
    obj.refs !== undefined
}

/**
 * Determines whether two entries are equal.
 * @param {module:Log~Entry} a An entry to compare.
 * @param {module:Log~Entry} b An entry to compare.
 * @return {boolean} True if a and b are equal, false otherwise.
 * @memberof module:Log~Entry
 * @private
 */
const isEqual = (a, b) => {
  return a && b && a.hash && a.hash === b.hash
}

/**
 * Decodes a serialized Entry from bytes
 * @param {Uint8Array} bytes
 * @return {module:Log~Entry}
 * @memberof module:Log~Entry
 * @private
 */
const decode = async (bytes, decryptEntryFn, decryptPayloadFn) => {
  let cid

  if (decryptEntryFn) {
    try {
      const encryptedEntry = await Block.decode({ bytes, codec, hasher })
      bytes = await decryptEntryFn(encryptedEntry.value)
      cid = encryptedEntry.cid
    } catch (e) {
      throw new Error('Could not decrypt entry')
    }
  }

  const decodedEntry = await Block.decode({ bytes, codec, hasher })
  const entry = decodedEntry.value

  if (decryptPayloadFn) {
    try {
      const decryptedPayloadBytes = await decryptPayloadFn(entry.payload)
      const { value: decryptedPayload } = await Block.decode({ bytes: decryptedPayloadBytes, codec, hasher })
      entry._payload = entry.payload
      entry.payload = decryptedPayload
    } catch (e) {
      throw new Error('Could not decrypt payload')
    }
  }

  cid = cid || decodedEntry.cid
  const hash = cid.toString(hashStringEncoding)

  return {
    ...entry,
    hash
  }
}

/**
 * Encodes an Entry and adds bytes field to it
 * @param {Entry} entry
 * @return {module:Log~Entry}
 * @memberof module:Log~Entry
 * @private
 */
const encode = async (entry, encryptEntryFn, encryptPayloadFn) => {
  const e = Object.assign({}, entry)

  if (encryptPayloadFn) {
    e.payload = e._payload
  }

  delete e._payload
  delete e.hash

  let { cid, bytes } = await Block.encode({ value: e, codec, hasher })

  if (encryptEntryFn) {
    bytes = await encryptEntryFn(bytes)
    const encryptedEntry = await Block.encode({ value: bytes, codec, hasher })
    cid = encryptedEntry.cid
    bytes = encryptedEntry.bytes
  }

  const hash = cid.toString(hashStringEncoding)

  return {
    hash,
    bytes
  }
}

export default {
  create,
  verify,
  decode,
  encode,
  isEntry,
  isEqual
}
