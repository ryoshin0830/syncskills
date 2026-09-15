import * as p from '@clack/prompts'

/** The user interrupted. Its own type, so "stopped" never reads as "said no". */
export class Cancelled extends Error {
  constructor() {
    super('cancelled — nothing was changed')
    this.name = 'Cancelled'
  }
}

/**
 * Unwrap a @clack answer.
 *
 * Ctrl-C does not reject; it resolves with a cancel SYMBOL. A symbol satisfies
 * every negative test a caller is likely to reach for — `x !== true`,
 * `typeof x !== 'string'` — so reading a prompt's result without coming
 * through here is how an interrupted run carries on and applies the plan.
 */
export function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Cancelled()
  return value as T
}

/**
 * A @clack validator refusing a field the user emptied.
 *
 * `p.text` returns '' for a cleared field rather than re-asking, so without
 * this a blank device name is written to the configuration and every commit
 * from that machine reads "sync from ".
 */
export function required(what: string): (value: string) => string | undefined {
  return (value) => (value.trim() === '' ? `${what} is required` : undefined)
}
