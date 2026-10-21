import type { ChatMessage } from '@ahjin/contracts';

/**
 * Deterministic checks around the model (defence in depth next to the system prompt, which the
 * model may still be talked out of). None of them is a security boundary on its own: permissions
 * and audit are enforced by the gateway's /mcp endpoint whatever the model does.
 */

/** Phrasings used to talk a model out of its instructions. Kept specific to avoid false alarms. */
const INJECTION_RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    // "ignore all previous instructions", but not "ignore my previous instruction, the price is…"
    rule: 'override_instructions',
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|every\s+)?(of\s+)?(your|the|these|those|previous|prior|above|earlier|system|original)\s+((previous|prior|above|earlier|system|original|safety)\s+)?(instructions?|rules?|prompts?|guidelines?|guardrails?|directives?|restrictions?)\b/i,
  },
  {
    // "show me your system prompt", but not "what are your rules on returns?"
    rule: 'prompt_extraction',
    pattern:
      /\b(reveal|show|print|repeat|output|dump|leak|tell me|what (is|are|was|were))\b[^.!?\n]{0,30}\b(system prompt|system message|hidden (instructions?|prompt)|initial (instructions?|prompt)|your (system )?(instructions|prompt)|developer (message|prompt))\b/i,
  },
  {
    rule: 'mode_switch',
    pattern: /\b(developer|god|jailbreak|jailbroken|dan|unrestricted|unfiltered|sudo) mode\b/i,
  },
  { rule: 'dan', pattern: /\bdo anything now\b/i },
  {
    rule: 'role_override',
    pattern:
      /\b(pretend|act as if|imagine|roleplay|role-play)\b[^.!?\n]{0,40}\b(no|without|free of|free from)\b[^.!?\n]{0,20}\b(rules|restrictions|limits|filters|guidelines|guardrails)\b/i,
  },
  {
    rule: 'new_instructions',
    pattern: /\b(new|updated) (system )?(instructions|rules|prompt)\s*:/i,
  },
];

export type ScreenResult = { ok: true } | { ok: false; rule: string };

/**
 * Screens every message the client sent. The history comes from the browser, so an earlier
 * "assistant" message is as untrusted as the latest question.
 */
export function screenMessages(messages: ChatMessage[]): ScreenResult {
  for (const message of messages) {
    for (const { rule, pattern } of INJECTION_RULES) {
      if (pattern.test(message.content)) return { ok: false, rule };
    }
  }
  return { ok: true };
}

export const BLOCKED_REPLY =
  "I can't help with that. I work within fixed rules that keep the store and the team's data safe. " +
  'I can look up or change products and orders, convert prices, and use the other connected services: what do you need?';

/** Secrets that must never reach the model or the browser, whatever an upstream returned. */
const SECRET_PATTERNS: RegExp[] = [
  /\bamcp_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/g, // gateway API keys
  /\bachat_[A-Za-z0-9_-]{20,}/g, // chat tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bgsk_[A-Za-z0-9]{40,}\b/g, // Groq
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google
  /\b(ck|cs)_[a-f0-9]{40}\b/g, // WooCommerce REST keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

/** Cluster-internal addresses (Service names, *.svc), which members are never shown (threat model). */
const INTERNAL_URL =
  /\bhttps?:\/\/(?:[a-z0-9-]+\.)*[a-z0-9-]+\.svc(?:\.cluster\.local)?(?::\d+)?(?:\/[^\s)"'<>]*)?|\bhttps?:\/\/(?:woo-mcp|fx-mcp|gateway|postgres|wordpress|mariadb|store-operator)(?::\d+)?(?:\/[^\s)"'<>]*)?/gi;

export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let result = text;
  for (const pattern of [...SECRET_PATTERNS, INTERNAL_URL]) {
    result = result.replace(pattern, () => {
      redacted += 1;
      return '[redacted]';
    });
  }
  return { text: result, redacted };
}

/**
 * Whether an answer states store data (money, order or product numbers). Used only when the model
 * answered without calling a single tool, which is how invented numbers usually appear.
 */
export function claimsStoreData(text: string): boolean {
  return (
    /(₹|\bINR|\bUSD|\bEUR|\bGBP|\$|€|£)\s?\d/.test(text) ||
    /\d[\d,.]*\s?(₹|INR|USD|EUR|GBP|rupees|dollars)\b/i.test(text) ||
    /#\d{1,8}\b/.test(text) ||
    /\b(order|product|sku)\s*(id|no\.?|number)?\s*[:#]?\s*\d{1,8}\b/i.test(text)
  );
}

/**
 * Whether a tool may change something, by the MCP annotation defaults: tools are assumed to have
 * side effects unless they say they're read-only, and to be destructive unless they say they
 * aren't. Such calls wait for the user's approval in the dashboard. A lying upstream can skip
 * this prompt, but not the gateway's permission checks.
 */
export function needsApproval(annotations: Record<string, unknown> | undefined): boolean {
  if (annotations?.readOnlyHint === true) return false;
  return annotations?.destructiveHint !== false;
}
