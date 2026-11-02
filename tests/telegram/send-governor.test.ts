import { describe, test, expect } from 'bun:test'
import { createSendGovernor } from '../../src/telegram/send-governor'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any

describe('send-governor', () => {
  test('passes non-chat methods straight through (no throttle)', async () => {
    const calls: number[] = []
    const gov = createSendGovernor(noopLog, { minGapMs: 1000 })
    const prev = async () => { calls.push(Date.now()); return { ok: true } }
    await gov(prev, 'getMe', {})
    await gov(prev, 'getMe', {})
    expect(calls.length).toBe(2)
  })

  test('enforces min gap between sends to the same chat', async () => {
    let clock = 0
    const sleeps: number[] = []
    const gov = createSendGovernor(noopLog, {
      minGapMs: 1000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms },
    })
    const prev = async () => ({ ok: true })
    await gov(prev, 'sendMessage', { chat_id: 42 })   // first: no wait
    await gov(prev, 'sendMessage', { chat_id: 42 })   // second: waits ~1000
    await gov(prev, 'sendMessage', { chat_id: 42 })   // third: waits ~1000
    expect(sleeps.filter((s) => s > 0)).toEqual([1000, 1000])
  })

  test('does not throttle across different chats', async () => {
    let clock = 0
    const sleeps: number[] = []
    const gov = createSendGovernor(noopLog, {
      minGapMs: 1000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms },
    })
    const prev = async () => ({ ok: true })
    await gov(prev, 'sendMessage', { chat_id: 1 })
    await gov(prev, 'sendMessage', { chat_id: 2 })
    expect(sleeps.filter((s) => s > 0)).toEqual([])  // distinct chats, no wait
  })

  test('honors 429 retry_after then retries and succeeds', async () => {
    const sleeps: number[] = []
    let n = 0
    const gov = createSendGovernor(noopLog, {
      minGapMs: 0,
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    const prev = async () => {
      n += 1
      if (n === 1) return { ok: false, error_code: 429, parameters: { retry_after: 2 } }
      return { ok: true }
    }
    const res = await gov(prev, 'sendMessage', { chat_id: 7 })
    expect(res.ok).toBe(true)
    expect(n).toBe(2)
    expect(sleeps).toContain(2 * 1000 + 250)
  })

  test('gives up after max 429 retries and returns the last 429 (no infinite hammer)', async () => {
    let n = 0
    const gov = createSendGovernor(noopLog, {
      minGapMs: 0,
      now: () => 0,
      max429Retries: 3,
      sleep: async () => {},
    })
    const prev = async () => { n += 1; return { ok: false, error_code: 429, parameters: { retry_after: 1 } } }
    const res = await gov(prev, 'sendMessage', { chat_id: 9 })
    expect(res.ok).toBe(false)
    expect(res.error_code).toBe(429)
    expect(n).toBe(4)  // initial + 3 retries, then stop
  })

  test('a throwing call does not wedge the chat chain', async () => {
    const gov = createSendGovernor(noopLog, { minGapMs: 0, now: () => 0, sleep: async () => {} })
    const boom = async () => { throw new Error('network') }
    const ok = async () => ({ ok: true })
    await expect(gov(boom, 'sendMessage', { chat_id: 5 })).rejects.toThrow('network')
    const res = await gov(ok, 'sendMessage', { chat_id: 5 })  // chain still usable
    expect(res.ok).toBe(true)
  })
})
