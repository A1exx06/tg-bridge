import { describe, test, expect } from 'bun:test'
import { createQueue } from '../../src/claude/queue'

describe('queue', () => {
  test('FIFO order', () => {
    const q = createQueue<string>({ maxDepth: 10 })
    q.push('a'); q.push('b'); q.push('c')
    expect(q.shift()).toBe('a')
    expect(q.shift()).toBe('b')
    expect(q.shift()).toBe('c')
    expect(q.shift()).toBeUndefined()
  })

  test('drops oldest when over maxDepth', () => {
    const q = createQueue<number>({ maxDepth: 3 })
    q.push(1); q.push(2); q.push(3); q.push(4)
    expect(q.size()).toBe(3)
    expect(q.shift()).toBe(2)
  })

  test('returns dropped item from push', () => {
    const q = createQueue<number>({ maxDepth: 2 })
    expect(q.push(1)).toBeUndefined()
    expect(q.push(2)).toBeUndefined()
    expect(q.push(3)).toBe(1)
  })
})

describe('shiftWhere (owner priority)', () => {
  test('returns the first matching item and keeps the rest in FIFO order', () => {
    const q = createQueue<{ ch: string; n: number }>({ maxDepth: 10 })
    q.push({ ch: 'swarm', n: 1 })
    q.push({ ch: 'swarm', n: 2 })
    q.push({ ch: 'telegram', n: 3 })
    q.push({ ch: 'telegram', n: 4 })
    expect(q.shiftWhere((i) => i.ch === 'telegram')).toEqual({ ch: 'telegram', n: 3 })
    expect(q.shiftWhere((i) => i.ch === 'telegram')).toEqual({ ch: 'telegram', n: 4 })
    expect(q.shiftWhere((i) => i.ch === 'telegram')).toBeUndefined()
    expect(q.shift()).toEqual({ ch: 'swarm', n: 1 })
    expect(q.shift()).toEqual({ ch: 'swarm', n: 2 })
    expect(q.size()).toBe(0)
  })
})
