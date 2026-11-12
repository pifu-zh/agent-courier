export function scopeOf(msg) {
  return msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
}

export function isAllowed(config, msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.senderIsBot || msg.senderType === 'bot' || msg.senderType === 'app') {
    return false;
  }
  if (msg.mentionAll) return false;
  if (
    !Array.isArray(config.allowedDmUsers) ||
    !config.allowedDmUsers.includes(msg.senderId)
  ) {
    return false;
  }
  if (msg.chatType === 'p2p') return true;
  if (msg.chatType !== 'group') return false;
  if (!Array.isArray(config.allowedChats) || !config.allowedChats.includes(msg.chatId)) {
    return false;
  }
  if (config.requireMention && !msg.mentionedBot) return false;
  return true;
}
