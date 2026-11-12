import { appendFileSync, readFileSync } from 'node:fs';

const logPath = process.env.FAKE_CHANNEL_LOG;
const scenarioPath = process.env.FAKE_CHANNEL_SCENARIO;
const clipLimit = Number(process.env.FAKE_CHANNEL_CLIP || 0);

function clip(value) {
  if (!clipLimit || typeof value !== 'string' || value.length <= clipLimit) return value;
  return `${value.slice(0, clipLimit)}…[len=${value.length}]`;
}

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    // test logging must never break the fake channel
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLarkChannel(options) {
  let handlers = {};
  let connected = false;
  let keepAlive = null;
  let seq = 0;

  record({
    type: 'create',
    appId: options.appId,
    policy: options.policy,
    safety: options.safety,
    outbound: options.outbound,
    source: options.source,
  });

  function dispatch(step) {
    record({ type: 'scenario', event: step.event, index: step.index });
    try {
      if (step.event === 'message') {
        return Promise.resolve(handlers.message?.(step.msg));
      }
      if (step.event === 'reject') {
        handlers.reject?.(step);
        return Promise.resolve();
      }
      if (step.event === 'error') {
        const error = new Error(step.message || 'fake channel error');
        error.code = step.code;
        handlers.error?.(error);
        return Promise.resolve();
      }
      if (step.event === 'reconnecting') {
        handlers.reconnecting?.();
        return Promise.resolve();
      }
      if (step.event === 'reconnected') {
        handlers.reconnected?.();
        return Promise.resolve();
      }
      return Promise.resolve();
    } catch (err) {
      record({ type: 'handler_error', message: err.message });
      return Promise.resolve();
    }
  }

  const channel = {
    on(arg1, arg2) {
      if (typeof arg1 === 'string') {
        handlers[arg1] = arg2;
      } else {
        handlers = { ...handlers, ...arg1 };
      }
      return () => {};
    },

    async connect() {
      connected = true;
      record({ type: 'connected' });
      keepAlive = setInterval(() => {}, 1 << 30);
      let scenario = [];
      if (scenarioPath) {
        try {
          scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
        } catch (err) {
          record({ type: 'scenario_error', message: err.message });
        }
      }
      scenario.forEach((step, index) => {
        setTimeout(() => {
          void dispatch({ ...step, index }).catch((err) => {
            record({ type: 'handler_reject', message: err.message });
          });
        }, Number(step.delayMs || 0));
      });
    },

    async disconnect() {
      connected = false;
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
      record({ type: 'disconnect' });
    },

    async send(chatId, input, opts) {
      seq += 1;
      record({ type: 'send', chatId, input, opts });
      return { messageId: `om_send_${seq}` };
    },

    async reply(msg, input, opts) {
      seq += 1;
      record({
        type: 'reply',
        chatId: msg.chatId,
        messageId: msg.messageId,
        input,
        opts,
      });
      if (process.env.FAKE_REPLY_FAIL === '1') throw new Error('fake reply failure');
      return { messageId: `om_reply_${seq}` };
    },

    async stream(chatId, input, opts) {
      seq += 1;
      const messageId = `om_stream_${seq}`;
      record({ type: 'stream.start', chatId, messageId, opts });
      if (process.env.FAKE_STREAM_FAIL === '1') {
        record({ type: 'stream.fail', messageId });
        throw new Error('fake stream failure');
      }
      if (process.env.FAKE_STREAM_HANG === '1') {
        record({ type: 'stream.hang', messageId });
        await new Promise(() => {});
      }
      const controller = {
        messageId,
        append: async (chunk) => {
          record({ type: 'stream.append', messageId, chunk: clip(chunk) });
        },
        setContent: async (content) => {
          record({ type: 'stream.content', messageId, content: clip(content) });
          if (process.env.FAKE_STREAM_CONTENT_FAIL === '1') {
            throw new Error('fake setContent failure');
          }
        },
      };
      await input.markdown(controller);
      record({ type: 'stream.end', messageId });
      return { messageId };
    },

    async addReaction(messageId, emojiType) {
      seq += 1;
      record({ type: 'reaction.add', messageId, emojiType });
      const delayMs = Number(process.env.FAKE_REACTION_DELAY_MS || 0);
      if (delayMs > 0) await sleep(delayMs);
      if (process.env.FAKE_REACTION_FAIL === '1') throw new Error('fake reaction failure');
      return `reaction_${seq}`;
    },

    async removeReaction(messageId, reactionId) {
      record({ type: 'reaction.remove', messageId, reactionId });
      if (process.env.FAKE_REACTION_FAIL === '1') throw new Error('fake reaction failure');
    },

    getBotIdentity() {
      return { name: 'Fake Bot', openId: 'ou_bot' };
    },

    getConnectionStatus() {
      return connected ? { state: 'connected' } : undefined;
    },
  };

  return channel;
}
