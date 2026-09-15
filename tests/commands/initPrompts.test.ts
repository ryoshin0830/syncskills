import { describe, it, expect } from 'vitest'
import { required } from '../../src/prompt.js'

describe('required', () => {
  it('rejects an answer the user cleared', () => {
    // @clack returns '' when the field is emptied and Enter pressed. A blank
    // device name reaches the config, and every commit is then "sync from ".
    expect(required('a device name')('')).toBeTypeOf('string')
    expect(required('a device name')('   ')).toBeTypeOf('string')
  })

  it('says which field is missing', () => {
    expect(required('a device name')('')).toMatch(/device name/)
  })

  it('accepts a real answer', () => {
    expect(required('a device name')('work-pc')).toBeUndefined()
  })
})
