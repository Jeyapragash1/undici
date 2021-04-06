'use strict'

/* global WebAssembly */

const { resolve } = require('path')
const { readFileSync } = require('fs')
const constants = require('./constants')
const assert = require('assert')
const WASM_BUILD = resolve(__dirname, './llhttp.wasm')
const bin = readFileSync(WASM_BUILD)
const mod = new WebAssembly.Module(bin)

const kOnHeadersComplete = 1
const kOnBody = 2
const kOnMessageComplete = 3
const kOnUpgrade = 4
const kOnHeaderField = 5
const kOnHeaderValue = 6

const kPtr = Symbol('kPrt')
const kBufferSize = Symbol('kBufferSize')
const kBufferPtr = Symbol('kBufferPtr')
const kBufferView = Symbol('kBufferView')
const kInst = Symbol('kInst')

class HTTPParserError extends Error {
  constructor (message, code) {
    super(message)
    Error.captureStackTrace(this, HTTPParserError)
    this.name = 'HTTPParserError'
    this.code = code ? `HPE_${code}` : undefined
  }
}

class HTTPParser {
  constructor () {
    // TODO (fix): Set sane memory limit?
    this[kInst] = new WebAssembly.Instance(mod, {
      env: {
        /* eslint-disable camelcase */
        wasm_on_message_begin: p => {
          return 0
        },
        wasm_on_url: (p, at, length) => {
          return 0
        },
        wasm_on_status: (p, at, length) => {
          return 0
        },
        wasm_on_header_field: (p, at, len) => {
          return this[kOnHeaderField](this[kInst].memory.buffer, at, len) || 0
        },
        wasm_on_header_value: (p, at, len) => {
          return this[kOnHeaderValue](this[kInst].memory.buffer, at, len) || 0
        },
        wasm_on_headers_complete: p => {
          const statusCode = this[kInst].llhttp_get_status_code(p)
          const upgrade = Boolean(this[kInst].llhttp_get_upgrade(p))
          const shouldKeepAlive = Boolean(this[kInst].llhttp_should_keep_alive(p))
          return this[kOnHeadersComplete](statusCode, upgrade, shouldKeepAlive)
        },
        wasm_on_body: (p, at, length) => {
          return this[kOnBody](this[kInst].memory.buffer, at, length) || 0
        },
        wasm_on_message_complete: (p) => {
          return this[kOnMessageComplete]() || 0
        }
        /* eslint-enable camelcase */
      }
    }).exports
  }

  [kOnHeaderField] (buf, at, len) {
    return 0
  }

  [kOnHeaderValue] (buf, at, len) {
    return 0
  }

  [kOnHeadersComplete] (statusCode, upgrade, shouldKeepAlive) {
    return 0
  }

  [kOnBody] (buf, at, len) {
    return 0
  }

  [kOnMessageComplete] () {
    return 0
  }

  [kOnUpgrade] (head) {
    return 0
  }

  construct (lenient) {
    assert(!this[kPtr])
    assert(!this[kBufferPtr])

    this[kPtr] = this[kInst].llhttp_alloc(constants.TYPE.RESPONSE)
    this[kBufferSize] = 0
    this[kBufferPtr] = null
    this[kBufferView] = null

    if (lenient) {
      this[kInst].llhttp_set_lenient_headers(this[kPtr], 1)
    }
  }

  destruct () {
    assert(this[kPtr])

    this[kInst].llhttp_free(this[kPtr])
    this[kPtr] = null

    if (this[kBufferPtr]) {
      this[kInst].free(this[kBufferPtr])
      this[kBufferPtr] = null
    }
  }

  execute (data) {
    assert(this[kPtr])

    // Be sure the parser buffer can contain `data`
    if (data.length > this[kBufferSize]) {
      if (this[kBufferPtr]) {
        this[kInst].free(this[kBufferPtr])
      }
      this[kBufferSize] = Math.ceil(data.length / 4096) * 4096
      this[kBufferPtr] = this[kInst].malloc(this[kBufferSize])
      // Instantiate a Unit8 Buffer view of the wasm memory that starts from the parser buffer pointer.
      this[kBufferView] = new Uint8Array(this[kInst].memory.buffer, this[kBufferPtr], this[kBufferSize])
    }

    this[kBufferView].set(data)

    // Call `execute` on the wasm parser.
    // We pass the `llhttp_parser` pointer address, the pointer address of buffer view data,
    // and finally the length of bytes to parse.
    // The return value is an error code or `constants.ERROR.OK`.
    // See https://github.com/dnlup/llhttp/blob/undici_wasm/src/native/api.c#L106
    const err = this[kInst].llhttp_execute(this[kPtr], this[kBufferPtr], data.length)

    if (err === constants.ERROR.PAUSED_UPGRADE) {
      const offset = this[kInst].llhttp_get_error_pos(this[kPtr]) - this[kBufferPtr]
      this[kOnUpgrade](data.slice(offset))
    } else if (err !== constants.ERROR.OK) {
      const ptr = this[kInst].llhttp_get_error_reason(this[kPtr])
      const len = this[kBufferView].indexOf(0, ptr) - ptr
      const message = Buffer.from(this[kInst].memory.buffer, ptr, len).toString()
      const code = constants.ERROR[err]
      return new HTTPParserError(message, code)
    }
  }
}

HTTPParser.kOnHeaderField = kOnHeaderField
HTTPParser.kOnHeaderValue = kOnHeaderValue
HTTPParser.kOnHeadersComplete = kOnHeadersComplete
HTTPParser.kOnBody = kOnBody
HTTPParser.kOnMessageComplete = kOnMessageComplete
HTTPParser.kOnUpgrade = kOnUpgrade

module.exports = HTTPParser