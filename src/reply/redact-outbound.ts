// Precision secret redaction for the MAIN outbound path (final reply text and
// the terminal mirror). Unlike progress/mask.ts, this deliberately has NO
// broad LONG_TOKEN/IPV4 rules: the agent's job includes sending full TRON
// addresses, tx ids, server IPs and long URLs to the operator — blanket
// masking would corrupt the payload the operator actually needs. Only
// patterns that are unambiguously credentials are masked here.
const RULES: Array<[RegExp, string]> = [
  // Telegram bot token: 8-10 digits ':' 35 chars
  [/\b(\d{3})\d{5,}:(AA)[\w-]{30,}/g, '$1***:$2***'],
  // OpenAI/Anthropic/Stripe-style prefixed keys
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{18,}\b/g, '$1-***'],
  // GitHub tokens
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'gh*_***'],
  // Slack tokens
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox*-***'],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  // JWT (three base64url segments, header starts with eyJ)
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, 'eyJ***.***.***'],
  // Bearer <token>
  [/\b([Bb]earer\s+)[A-Za-z0-9._~+/=-]{20,}\b/g, '$1***'],
  // Explicit env-style assignments of secret-looking vars (terminal mirror case:
  // `export FOO_TOKEN=...`, `API_KEY=...`); value may be quoted.
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)['"]?[^\s'"]{8,}['"]?/g, '$1***'],
  // Query-string credentials
  [/([?&](?:token|api_key|apikey|key|secret|password)=)[^&\s]{6,}/gi, '$1***'],
]

export function redactOutbound(s: string): string {
  if (!s) return s
  let out = s
  for (const [re, sub] of RULES) out = out.replace(re, sub)
  return out
}
