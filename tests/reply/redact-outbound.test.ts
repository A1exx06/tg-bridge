import { describe, expect, test } from 'bun:test'
import { redactOutbound } from '../../src/reply/redact-outbound.js'

describe('redactOutbound — маскирует однозначные секреты', () => {
  test('telegram bot token', () => {
    expect(redactOutbound('token 8532053998:AAHf3kQ9xLmZp2Yw8vB1cD4eF6gH7jK9mNo')).not.toContain('AAHf3kQ9')
  })
  test('sk-ключ', () => {
    expect(redactOutbound('key sk-ant-api03-abcdefghijklmnopqrst')).toBe('key sk-***')
  })
  test('github pat', () => {
    expect(redactOutbound('ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe('gh*_***')
  })
  test('JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P'
    expect(redactOutbound(jwt)).toBe('eyJ***.***.***')
  })
  test('Bearer', () => {
    expect(redactOutbound('curl -H "Authorization: Bearer abcdef1234567890abcdef1234"')).toContain('Bearer ***')
  })
  test('env-присвоение из зеркала', () => {
    expect(redactOutbound('export MINIMAX_API_KEY=abc123def456ghij')).toBe('export MINIMAX_API_KEY=***')
  })
  test('query-string', () => {
    expect(redactOutbound('https://x.com/cb?token=abcdef123456&x=1')).toBe('https://x.com/cb?token=***&x=1')
  })
})

describe('redactOutbound — НЕ трогает рабочий контент', () => {
  test('TRON-адрес остаётся полным', () => {
    const s = 'адрес TN9RRaXkCFtTXRso2GdTZLSs1PEmMdVHiv сверь до отправки'
    expect(redactOutbound(s)).toBe(s)
  })
  test('txid остаётся полным', () => {
    const s = 'tx 7f9c2ab8d4e5f6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5'
    expect(redactOutbound(s)).toBe(s)
  })
  test('IP остаётся полным', () => {
    const s = 'сервер 94.228.163.78, туннель на 89.124.88.120:5433'
    expect(redactOutbound(s)).toBe(s)
  })
  test('youtube-ссылка остаётся', () => {
    const s = 'видео https://youtu.be/7t-bstAJQ50 залито'
    expect(redactOutbound(s)).toBe(s)
  })
  test('обычный длинный слаг остаётся', () => {
    const s = 'файл 2026-07-04-visa-mpesa-stablecoin.md обновлён'
    expect(redactOutbound(s)).toBe(s)
  })
})
