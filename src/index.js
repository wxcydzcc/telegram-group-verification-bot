const DEFAULT_TIMEOUT_MINUTES = 2;
const DEFAULT_REJOIN_COOLDOWN_MINUTES = 30;

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
  const challengeId = randomToken(8);
  const displayName = escapeHtml(fullName(user));
  const mention = `<a href="tg://user?id=${user.id}">${displayName}</a>`;
  const replyMarkup = {
    inline_keyboard: [0, 2].map((start) =>
      challenge.options.slice(start, start + 2).map((option, offset) => ({
        text: String(option),
        callback_data: `gv:${user.id}:${challengeId}:${start + offset}`,
      })),
    ),
  };

  const prompt = await telegram(env, "sendMessage", {
    chat_id: chat.id,
    parse_mode: "HTML",
    text:
      `🔐 <b>新成员验证</b>\n\n` +
      `${mention}，欢迎加入【${escapeHtml(groupName(env))}】。\n` +
      `请在 ${timeoutMinutes} 分钟内完成：<b>${escapeHtml(challenge.prompt)}</b>\n\n` +
      `只有一次选择机会。验证通过后自动解除禁言；答错或超时将被移出群组。`,
    reply_markup: replyMarkup,
  });

  await env.BOT_DATA.put(
    key,
    JSON.stringify({
      chatId: chat.id,
      userId: user.id,
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      challengeId,
      correctIndex: challenge.correctIndex,
      challengeKind: challenge.kind,
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
  const [, targetRaw, challengeId, optionRaw] = data.split(":");
  const targetUserId = Number(targetRaw);
  const optionIndex = Number(optionRaw);

  if (!chatId || !targetUserId || !challengeId || !Number.isInteger(optionIndex)) {
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
  if (challengeId !== record.challengeId || optionIndex < 0 || optionIndex >= 4) {
    await answerCallback(env, query.id, "验证信息不匹配，请重新加入群组。", true);
    return;
  }

  if (Date.now() > Number(record.expiresAt)) {
    await removeUnverifiedUser(record, env, "验证超时");
    await env.BOT_DATA.delete(key);
    await answerCallback(env, query.id, "验证已超时，请重新加入群组。", true);
    return;
  }

  if (!(await claimChallengeButtons(query, env))) {
    await answerCallback(env, query.id, "该验证已经处理，请勿重复点击。", true);
    return;
  }

  await env.BOT_DATA.delete(key);

  if (optionIndex === Number(record.correctIndex)) {
    await restoreDefaultPermissions(chatId, targetUserId, env);
    await safeDeleteMessage(chatId, record.messageId, env);
    await answerCallback(env, query.id, "验证成功，欢迎加入！", false);
    await sendWelcome(record, env);
    return;
  }

  await removeUnverifiedUser(record, env, "答案错误");
  await answerCallback(
    env,
    query.id,
    `答案错误，已移出群组。${getRejoinCooldownMinutes(env)} 分钟后可重新尝试。`,
    true,
  );
}

export function buildChallenge(randomInt = secureRandomInt, forcedKind) {
  const kinds = ["arithmetic", "largest", "count", "sequence"];
  const kind = forcedKind || kinds[randomInt(0, kinds.length - 1)];

  if (kind === "largest") {
    const values = uniqueRandomNumbers(4, 11, 98, randomInt);
    const options = shuffle(values, randomInt);
    const largest = Math.max(...values);
    return {
      kind,
      prompt: "请选择下面最大的数字",
      options,
      correctIndex: options.indexOf(largest),
    };
  }

  if (kind === "count") {
    const count = randomInt(3, 8);
    const icon = ["◆", "●", "▲", "■"][randomInt(0, 3)];
    return numericChallenge(kind, `数一数：${Array(count).fill(icon).join(" ")} 一共有几个？`, count, randomInt);
  }

  if (kind === "sequence") {
    const first = randomInt(1, 7);
    const step = randomInt(2, 5);
    const sequence = [first, first + step, first + step * 2];
    return numericChallenge(kind, `找规律：${sequence.join("，")}，下一个数字是？`, first + step * 3, randomInt);
  }

  const left = randomInt(8, 24);
  const right = randomInt(2, 9);
  const subtract = randomInt(0, 1) === 1;
  const correct = subtract ? left - right : left + right;
  const operator = subtract ? "−" : "+";
  return numericChallenge(kind, `计算：${left} ${operator} ${right} = ?`, correct, randomInt);
}

function numericChallenge(kind, prompt, correct, randomInt) {
  const values = new Set([correct]);
  while (values.size < 4) {
    const offset = randomInt(-7, 7);
    values.add(Math.max(1, correct + (offset === 0 ? 8 : offset)));
  }
  const options = shuffle([...values], randomInt);
  return { kind, prompt, options, correctIndex: options.indexOf(correct) };
}

function uniqueRandomNumbers(count, min, max, randomInt) {
  const values = new Set();
  while (values.size < count) values.add(randomInt(min, max));
  return [...values];
}

function randomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
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
    const untilDate = Math.floor(Date.now() / 1000) + getRejoinCooldownMinutes(env) * 60;
    await telegram(env, "banChatMember", {
      chat_id: record.chatId,
      user_id: record.userId,
      until_date: untilDate,
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

async function claimChallengeButtons(query, env) {
  try {
    await telegram(env, "editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    if (/message is not modified|message to edit not found/i.test(message)) return false;
    throw error;
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

function getRejoinCooldownMinutes(env) {
  return Math.max(1, Number(env.REJOIN_COOLDOWN_MINUTES || DEFAULT_REJOIN_COOLDOWN_MINUTES));
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
