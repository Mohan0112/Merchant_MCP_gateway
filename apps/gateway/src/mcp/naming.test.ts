import { describe, expect, it } from 'vitest';
import { exposedName, slugOf } from './naming';

describe('tool naming', () => {
  it('prefixes the tool with its server slug', () => {
    expect(exposedName('woo', 'list_orders')).toBe('woo__list_orders');
    expect(slugOf('woo__list_orders')).toBe('woo');
  });

  it('keeps two servers with the same tool name apart', () => {
    expect(exposedName('woo', 'get_order')).not.toBe(exposedName('shopify', 'get_order'));
  });

  it('replaces characters that MCP clients and LLM APIs reject', () => {
    expect(exposedName('gh', 'issues.create/v2')).toBe('gh__issues_create_v2');
  });

  it('shortens long names to 64 characters, stably, without colliding', () => {
    const a = exposedName('github', `create_${'x'.repeat(80)}_a`);
    const b = exposedName('github', `create_${'x'.repeat(80)}_b`);
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^github__[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(exposedName('github', `create_${'x'.repeat(80)}_a`)).toBe(a);
    expect(slugOf(a)).toBe('github');
  });

  it('has no slug for names without a separator', () => {
    expect(slugOf('list_orders')).toBeNull();
  });
});
