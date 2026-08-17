const DEFAULT_TIMEOUT_MINUTES = 5;
const DEFAULT_MAX_ATTEMPTS = 3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "telegram-group-verification-bot" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    ctx.waitUntil(
      processUpdate(update, env).catch((error) => {
        console.error("Update failed", update?.update_id, error?.message || error);
      }),
    );
    return Response.json({ ok: true });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      cleanupExpiredVerifications(env).catch((error) => {
        console.error("Cleanup failed", error?.message || error);
      }),
    );
  },
};

async function processUpdate(update, env) {
  validateEnvironment(env);

  if (update.update_id !== undefined) {
    const key = `update:${update.update_id}`;
    if (await env.BOT_DATA.get(key)) return;
    await env.BOT_DATA.put(key, "1", { expirationTtl: 86400 });
  }

  if (update.callback_query) {
    await handleVerificationCallback(update.callback_query, env);
    return;
  }

  if (update.chat_member) {
    await handleChatMemberUpdate(update.chat_member, env);
    return;
  }

  if (update.message) {
    await handleMessage(update.message, env);
  }
}

function validateEnvironment(env) {
  const required = ["BOT_TOKEN", "WEBHOOK_SECRET", "GROUP_CHAT_ID", "GROUP_URL"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing bindings: ${missing.join(", ")}`);
  if (!env.BOT_DATA) throw new Error("Missing KV binding: BOT_DATA");
}

async function handleChatMemberUpdate(change, env) {
  const chat = change.chat;
  const user = change.new_chat_member?.user;
  if (!chat || !user || user.is_bot) return;
  if (String(chat.id) !== String(env.GROUP_CHAT_ID)) return;

  const wasMember = membershipAllowed(change.old_chat_member);
  const isMemberNow = membershipAllowed(change.new_chat_member);

  if (!wasMember && isMemberNow) {
    await startVerification(chat, user, env);
    return;
  }

  if (wasMember && !isMemberNow) {
    await clearPendingVerification(chat.id, user.id, env);
  }
}

async function handleMessage(message, env) {
  if (!message.from || message.from.is_bot) return;

  if (message.chat.type === "private") {
    if (message.text === "/start") {
      await sendMessage(
        env,
        message.chat.id,
        `本机器人仅负责【${groupName(env)}】的新成员验证。\n\n请从群组链接加入：${env.GROUP_URL}`,
      );
    }
    return;
  }

  if (message.chat.type !== "group" && message.chat.type !== "supergroup") return;

  const text = String(message.text || "").trim();
  if (text === "/chatid" || text.startsWith("/chatid@")) {
    if (await isGroupAdmin(message.chat.id, message.from.id, env)) {
      await sendMessage(env, message.chat.id, `当前群组数字ID：${message.chat.id}`);
    }
    return;
  }

  if (String(message.chat.id) !== String(env.GROUP_CHAT_ID)) return;

  if (text === "/verify_stats" || text.startsWith("/verify_stats@")) {
    if (await isGroupAdmin(message.chat.id, message.from.id, env)) {
      const pending = await countKeys(env, `verify:${message.chat.id}:`);
      await sendMessage(env, message.chat.id, `当前等待验证：${pending} 人`);
    }
    return;
  }

  // Fallback for clients where the join arrives as a service message.
  if (Array.isArray(message.new_chat_members)) {
    for (const user of message.new_chat_members) {
      if (!user.is_bot) await startVerification(message.chat, user, env);
    }
    await safeDeleteMessage(message.chat.id, message.message_id, env);
    return;
  }

  // New members should already be muted. This closes the small race window.
  if (await env.BOT_DATA.get(`verify:${message.chat.id}:${message.from.id}`)) {
    await safeDeleteMessage(message.chat.id, message.message_id, env);
  }
}

async function startVerification(chat, user, env) {
  const key = `verify:${chat.id}:${user.id}`;
  if (await env.BOT_DATA.get(key)) return;

  await telegram(env, "restrictChatMember", {
    chat_id: chat.id,
    user_id: user.id,
    permissions: { can_send_messages: false },
    use_independent_chat_permissions: true,
  });

  const timeoutMinutes = getTimeoutMinutes(env);
  const challenge = buildChallenge();
  const displayName = escapeHtml(fullName(user));
  const mention = `<a href="tg://user?id=${user.id}">${displayName}</a>`;
  const replyMarkup = {
    inline_keyboard: [
      challenge.options.map((answer) => ({
        text: String(answer),
        callback_data: `gv:${user.id}:${answer}`,
      })),
    ],
  };

  const prompt = await telegram(env, "sendMessage", {
    chat_id: chat.id,
    parse_mode: "HTML",
    text:
      `🔐 <b>新成员验证</b>\n\n` +
      `${mention}，欢迎加入【${escapeHtml(groupName(env))}】。\n` +
      `请在 ${timeoutMinutes} 分钟内回答：<b>${challenge.a} + ${challenge.b} = ?</b>\n\n` +
      `验证通过后自动解除禁言；超时或连续答错 ${getMaxAttempts(env)} 次将被移出群组。`,
    reply_markup: replyMarkup,
  });

  await env.BOT_DATA.put(
    key,
    JSON.stringify({
      chatId: chat.id,
      userId: user.id,
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      correct: challenge.correct,
      attempts: 0,
      messageId: prompt.message_id,
      expiresAt: Date.now() + timeoutMinutes * 60_000,
    }),
    { expirationTtl: 86400 },
  );
}

async function handleVerificationCallback(query, env) {
  const data = String(query.data || "");
  if (!data.startsWith("gv:")) {
    await answerCallback(env, query.id, "无效操作。", true);
    return;
  }

  const chatId = query.message?.chat?.id;
  const [, targetRaw, answerRaw] = data.split(":");
  const targetUserId = Number(targetRaw);
  const answer = Number(answerRaw);

  if (!chatId || !targetUserId || !Number.isFinite(answer)) {
    await answerCallback(env, query.id, "验证信息无效，请重新入群。", true);
    return;
  }

  if (String(chatId) !== String(env.GROUP_CHAT_ID)) {
    await answerCallback(env, query.id, "该群组未启用验证。", true);
    return;
  }

  if (query.from.id !== targetUserId) {
    await answerCallback(env, query.id, "这不是你的验证按钮。", true);
    return;
  }

  const key = `verify:${chatId}:${targetUserId}`;
  const raw = await env.BOT_DATA.get(key);
  if (!raw) {
    await answerCallback(env, query.id, "验证已失效，请重新加入群组。", true);
    return;
  }

  const record = JSON.parse(raw);
  if (Date.now() > Number(record.expiresAt)) {
    await removeUnverifiedUser(record, env, "验证超时");
    await env.BOT_DATA.delete(key);
    await answerCallback(env, query.id, "验证已超时，请重新加入群组。", true);
    return;
  }

  if (answer === Number(record.correct)) {
    await restoreDefaultPermissions(chatId, targetUserId, env);
    await safeDeleteMessage(chatId, record.messageId, env);
    await env.BOT_DATA.delete(key);
    await answerCallback(env, query.id, "验证成功，欢迎加入！", false);
    await sendWelcome(record, env);
    return;
  }

  record.attempts = Number(record.attempts || 0) + 1;
  const maxAttempts = getMaxAttempts(env);
  if (record.attempts >= maxAttempts) {
    await removeUnverifiedUser(record, env, `连续答错 ${maxAttempts} 次`);
    await env.BOT_DATA.delete(key);
    await answerCallback(env, query.id, `连续答错 ${maxAttempts} 次，已移出群组。`, true);
    return;
  }

  await env.BOT_DATA.put(key, JSON.stringify(record), { expirationTtl: 86400 });
  await answerCallback(env, query.id, `答案错误，还可尝试 ${maxAttempts - record.attempts} 次。`, true);
}

export function buildChallenge(randomInt = secureRandomInt) {
  const a = randomInt(2, 9);
  const b = randomInt(2, 9);
  const correct = a + b;
  const answers = new Set([correct]);
  while (answers.size < 4) {
    const offset = randomInt(-5, 5);
    answers.add(Math.max(1, correct + (offset === 0 ? 6 : offset)));
  }
  return { a, b, correct, options: shuffle([...answers], randomInt) };
}

export function membershipAllowed(member) {
  if (!member) return false;
  if (["creator", "administrator", "member"].includes(member.status)) return true;
  return member.status === "restricted" && member.is_member === true;
}

function secureRandomInt(min, max) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return min + (values[0] % (max - min + 1));
}

function shuffle(values, randomInt = secureRandomInt) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function restoreDefaultPermissions(chatId, userId, env) {
  const chat = await telegram(env, "getChat", { chat_id: chatId });
  const permissions = chat.permissions || {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
  };

  await telegram(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions,
    use_independent_chat_permissions: true,
  });
}

async function sendWelcome(record, env) {
  const mention = `<a href="tg://user?id=${record.userId}">${escapeHtml(
    [record.firstName, record.lastName].filter(Boolean).join(" ") || "新成员",
  )}</a>`;

  const payload = {
    chat_id: record.chatId,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    text:
      `🎉 欢迎 ${mention} 加入【${escapeHtml(groupName(env))}】！\n\n` +
      `这里专注网站建设、服务器运维、金融科技、支付系统接入及跨境收款。\n\n` +
      `📌 <b>新成员须知</b>\n` +
      `• 请在对应【话题】中发言\n` +
      `• 提问时说明运行环境、报错信息和已尝试的方法\n` +
      `• 禁止广告引流、黑灰产、资金盘、违法及恶意引战内容\n\n` +
      `⚠️ 管理员不会主动私聊收费，也不会索要密码、验证码、私钥或助记词。\n\n` +
      `分享经验，讨论技术，共同进步。`,
  };
  const keyboard = buildLinkKeyboard(env);
  if (keyboard) payload.reply_markup = keyboard;
  await telegram(env, "sendMessage", payload);
}

export function buildLinkKeyboard(env) {
  const candidates = [
    [env.CHANNEL_LABEL || "Channel", env.CHANNEL_URL],
    [env.YOUTUBE_LABEL || "YouTube", env.YOUTUBE_URL],
    [env.FORUM_LABEL || "Forum", env.FORUM_URL],
    [env.WEBSITE_LABEL || "Website", env.WEBSITE_URL],
    [env.X_LABEL || "X", env.X_URL],
    [env.BLOG_LABEL || "Blog", env.BLOG_URL],
    [env.NAV_LABEL || "Links", env.NAV_URL],
    [env.STORE_LABEL || "Store", env.STORE_URL],
  ].filter(([, url]) => isHttpUrl(url));

  if (!candidates.length) return undefined;
  const rows = [];
  for (let index = 0; index < candidates.length; index += 2) {
    rows.push(
      candidates.slice(index, index + 2).map(([text, url]) => ({ text: String(text), url: String(url) })),
    );
  }
  return { inline_keyboard: rows };
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

function groupName(env) {
  return String(env.GROUP_NAME || "Community Group").trim();
}

async function cleanupExpiredVerifications(env) {
  validateEnvironment(env);
  const now = Date.now();
  let cursor;

  do {
    const page = await env.BOT_DATA.list({ prefix: `verify:${env.GROUP_CHAT_ID}:`, limit: 1000, cursor });
    for (const key of page.keys) {
      const raw = await env.BOT_DATA.get(key.name);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        await env.BOT_DATA.delete(key.name);
        continue;
      }

      if (Number(record.expiresAt || 0) <= now) {
        await removeUnverifiedUser(record, env, "验证超时");
        await env.BOT_DATA.delete(key.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function removeUnverifiedUser(record, env, reason) {
  try {
    await telegram(env, "banChatMember", {
      chat_id: record.chatId,
      user_id: record.userId,
    });
    // Immediately unban so a real user may rejoin and try verification again.
    await telegram(env, "unbanChatMember", {
      chat_id: record.chatId,
      user_id: record.userId,
      only_if_banned: true,
    });
  } finally {
    await safeDeleteMessage(record.chatId, record.messageId, env);
    console.log("Removed unverified user", record.userId, reason);
  }
}

async function clearPendingVerification(chatId, userId, env) {
  const key = `verify:${chatId}:${userId}`;
  const raw = await env.BOT_DATA.get(key);
  if (!raw) return;
  try {
    const record = JSON.parse(raw);
    await safeDeleteMessage(chatId, record.messageId, env);
  } finally {
    await env.BOT_DATA.delete(key);
  }
}

async function isGroupAdmin(chatId, userId, env) {
  try {
    const member = await telegram(env, "getChatMember", { chat_id: chatId, user_id: userId });
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

async function countKeys(env, prefix) {
  let count = 0;
  let cursor;
  do {
    const page = await env.BOT_DATA.list({ prefix, limit: 1000, cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

async function answerCallback(env, callbackId, text, showAlert) {
  try {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text,
      show_alert: showAlert,
    });
  } catch {
    // Telegram callback answers expire quickly; verification state remains valid.
  }
}

async function safeDeleteMessage(chatId, messageId, env) {
  if (!messageId) return;
  try {
    await telegram(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // The message may already be gone or the bot may not have delete permission.
  }
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`${method}: ${data.description || response.statusText}`);
  }
  return data.result;
}

function getTimeoutMinutes(env) {
  return Math.max(2, Number(env.VERIFY_TIMEOUT_MINUTES || DEFAULT_TIMEOUT_MINUTES));
}

function getMaxAttempts(env) {
  return Math.max(1, Number(env.MAX_VERIFY_ATTEMPTS || DEFAULT_MAX_ATTEMPTS));
}

function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "新成员";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
