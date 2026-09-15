import { describe, it, expect } from 'vitest'
import { Writable, Readable } from 'node:stream'
import { ConfirmPrompt, isCancel } from '@clack/core'
import { answer, Cancelled } from '../src/prompt.js'

/**
 * A genuine cancel value from @clack itself. Hand-made symbols would not do:
 * the library uses a unique `Symbol('clack:cancel')`, so only the real one
 * satisfies `isCancel`.
 */
async function cancelValue(): Promise<unknown> {
  const input = new Readable({ read() {} }) as Readable & { isTTY: boolean; setRawMode: () => void }
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new Writable({ write(_c, _e, cb) { cb() } })
  const prompt = new ConfirmPrompt({
    input, output, active: 'Yes', inactive: 'No', initialValue: true, render: () => 'q',
  })
  const done = prompt.prompt()
  setTimeout(() => input.push('\x03'), 10)
  return done
}

describe('answer', () => {
  it('turns a cancelled prompt into a Cancelled', async () => {
    const cancelled = await cancelValue()
    expect(isCancel(cancelled)).toBe(true)
    expect(() => answer(cancelled)).toThrow(Cancelled)
  })

  it('passes an ordinary answer through, including a falsy one', async () => {
    expect(answer(false)).toBe(false)
    expect(answer('skip')).toBe('skip')
    expect(answer(0)).toBe(0)
  })

  it('catches what a plain comparison would miss', async () => {
    const cancelled = await cancelValue()
    // This is the whole point. A cancel value is a symbol, so every negative
    // test a caller might reach for silently treats it as an answer:
    expect(cancelled !== true).toBe(true)          // reads as "the user said no"
    expect(typeof cancelled !== 'string').toBe(true) // reads as "not a choice"
    expect(() => answer(cancelled)).toThrow(Cancelled)
  })
})
