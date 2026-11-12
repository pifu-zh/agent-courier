let sequence = 0;

export function nextMessageId() {
  sequence += 1;
  return `om_test_${sequence}`;
}

export function textMessage(overrides = {}) {
  return {
    messageId: nextMessageId(),
    chatId: 'oc_test',
    chatType: 'group',
    senderId: 'ou_test',
    senderIsBot: false,
    content: 'hello',
    mentionedBot: true,
    mentions: [],
    mentionAll: false,
    createTime: Date.now(),
    rawContentType: 'text',
    resources: [],
    ...overrides,
  };
}

export function dmMessage(overrides = {}) {
  return textMessage({
    chatId: 'oc_dm',
    chatType: 'p2p',
    mentionedBot: false,
    ...overrides,
  });
}

export function command(content, overrides = {}) {
  return textMessage({ content, ...overrides });
}
