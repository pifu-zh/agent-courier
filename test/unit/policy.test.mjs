import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, scopeOf } from '../../src/policy.mjs';

const config = {
  allowedDmUsers: ['ou_owner'],
  allowedChats: ['oc_group'],
  requireMention: true,
};

function dm(overrides = {}) {
  return {
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_owner',
    senderIsBot: false,
    mentionedBot: false,
    ...overrides,
  };
}

function group(overrides = {}) {
  return {
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_owner',
    senderIsBot: false,
    mentionedBot: true,
    ...overrides,
  };
}

test('dm from owner is allowed', () => {
  assert.equal(isAllowed(config, dm()), true);
});

test('dm from unknown user is denied', () => {
  assert.equal(isAllowed(config, dm({ senderId: 'ou_other' })), false);
});

test('bot sender is denied even in an allowed dm', () => {
  assert.equal(isAllowed(config, dm({ senderIsBot: true })), false);
  assert.equal(isAllowed(config, dm({ senderType: 'bot' })), false);
  assert.equal(isAllowed(config, dm({ senderType: 'app' })), false);
});

test('mention-all messages are denied at the bot layer', () => {
  assert.equal(isAllowed(config, group({ mentionAll: true })), false);
});

test('group message requires mention', () => {
  assert.equal(isAllowed(config, group()), true);
  assert.equal(isAllowed(config, group({ mentionedBot: false })), false);
});

test('group must be allowlisted and sender must be allowed', () => {
  assert.equal(isAllowed(config, group({ chatId: 'oc_other' })), false);
  assert.equal(isAllowed(config, group({ senderId: 'ou_other' })), false);
});

test('unknown chat types are denied', () => {
  assert.equal(isAllowed(config, dm({ chatType: 'unknown' })), false);
  assert.equal(isAllowed(config, null), false);
});

test('requireMention=false allows group messages without mention', () => {
  assert.equal(
    isAllowed({ ...config, requireMention: false }, group({ mentionedBot: false })),
    true,
  );
});

test('scope includes thread id when present', () => {
  assert.equal(scopeOf({ chatId: 'oc_x' }), 'oc_x');
  assert.equal(scopeOf({ chatId: 'oc_x', threadId: 'omt_y' }), 'oc_x:omt_y');
});
