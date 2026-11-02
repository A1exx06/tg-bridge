import { describe, test, expect } from 'bun:test'
import { routeFile } from '../../src/reply/file-route'

const WL = [897656531]

describe('routeFile', () => {
  test('no chat → last inbound', () => {
    expect(routeFile({ path: '/x' }, 100, WL)).toEqual({ action: 'send', chat: 100 })
  })

  test('no chat and no last inbound → drop', () => {
    expect(routeFile({ path: '/x' }, undefined, WL)).toEqual({
      action: 'drop',
      reason: 'no-last-inbound',
    })
  })

  test('chat in whitelist → send to that chat', () => {
    expect(routeFile({ path: '/x', chat: 897656531 }, 100, WL)).toEqual({
      action: 'send',
      chat: 897656531,
    })
  })

  test('chat not in whitelist → drop, never reroutes to last inbound', () => {
    const r = routeFile({ path: '/x', chat: 555 }, 100, WL)
    expect(r.action).toBe('drop')
    if (r.action === 'send') throw new Error('must not send')
    expect(r.reason).toBe('chat-not-whitelisted')
  })

  test('proactive disabled (empty whitelist) → drop even for valid-looking chat', () => {
    expect(routeFile({ path: '/x', chat: 897656531 }, 100, [])).toEqual({
      action: 'drop',
      reason: 'proactive-disabled',
    })
  })
})
