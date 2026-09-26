#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_FILE="$ROOT/apps/web/reproduce-result.html"

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3000}" \
OPERATOR_PASSWORD='Code8-30-B-Repro-2026!' \
VARIANT_LABEL='B' \
REPORT_FILE="$REPORT_FILE" \
node --input-type=module <<'NODE'
import fs from 'node:fs/promises';

const base = process.env.API_BASE_URL.replace(/\/$/, '');
const operatorPassword = process.env.OPERATOR_PASSWORD;
const variant = process.env.VARIANT_LABEL;
const reportFile = process.env.REPORT_FILE;
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `code8-30-${variant.toLowerCase()}-race-${stamp}@example.test`;
const operatorEmail = `code8-30-${variant.toLowerCase()}-operator@example.test`;
const initialPassword = 'Initial-Password-2026!';
const passwordOne = 'Concurrent-One-2026!';
const passwordTwo = 'Concurrent-Two-2026!';
const retryPassword = 'Old-Device-Retry-2026!';

class CookieJar {
  constructor() { this.cookie = ''; }
  capture(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = String(value).split(';', 1)[0];
      if (pair.startsWith('pbt_session=')) this.cookie = pair;
    }
  }
}

async function request(path, { method = 'GET', body, jar } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar?.cookie) headers.cookie = jar.cookie;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  jar?.capture(response);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function register(emailValue, password, jar) {
  return request('/auth/register', { method: 'POST', body: { email: emailValue, password }, jar });
}

async function login(emailValue, password, jar) {
  return request('/auth/login', { method: 'POST', body: { email: emailValue, password }, jar });
}

async function changePassword(jar, currentPassword, newPassword) {
  return request('/auth/password', {
    method: 'PATCH',
    body: { currentPassword, newPassword },
    jar
  });
}

async function me(jar) {
  return request('/auth/me', { jar });
}

async function timeline(jar) {
  return request('/timeline?eventType=PASSWORD_CHANGED&pageSize=100', { jar });
}

function assertCheck(checks, name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function writeReport(checks, summary) {
  const passed = checks.every((check) => check.ok);
  const rows = checks.map((check) => `<li class="${check.ok ? 'ok' : 'bad'}"><strong>${check.ok ? 'PASS' : 'FAIL'}</strong> ${escapeHtml(check.name)}<br><span>${escapeHtml(check.detail)}</span></li>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Code8-30 ${variant} 并发改密校验</title><style>
    body{margin:0;background:#eef2f7;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    main{max-width:1080px;margin:34px auto;padding:0 28px 40px}.eyebrow{color:#52627a;font-weight:700;letter-spacing:.12em}
    h1{font-size:34px;margin:8px 0 12px}.summary{font-size:18px;line-height:1.6}.verdict{margin:24px 0;padding:18px 22px;border-radius:14px;color:#fff;font-size:26px;font-weight:800;background:${passed ? '#067647' : '#b42318'}}
    ul{list-style:none;padding:0;display:grid;gap:10px}.card{padding:15px 18px;border-radius:12px;background:#fff;box-shadow:0 3px 14px rgba(23,32,51,.09)}
    .card::before{content:'';display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:10px;background:${passed ? '#12b76a' : '#f04438'}}
    span{color:#52627a;font-size:14px}
  </style></head><body><main><div class="eyebrow">CODE8-30 · VARIANT ${variant}</div><h1>多端并发改密一致性验证</h1><p class="summary">${escapeHtml(summary)}</p><div class="verdict">${passed ? '并发改密校验 PASS' : '当前验证失败'}</div><ul>${rows}</ul></main></body></html>`;
  return fs.writeFile(reportFile, html, 'utf8');
}

const checks = [];
let summary = '';
try {
  const operatorJar = new CookieJar();
  const operator = await register(operatorEmail, operatorPassword, operatorJar);
  assertCheck(checks, '准备独立验证账号', operator.status === 201 || operator.status === 409, `注册状态 ${operator.status}`);

  const deviceOne = new CookieJar();
  const registered = await register(email, initialPassword, deviceOne);
  assertCheck(checks, '设备一建立真实会话', registered.status === 201 && Boolean(deviceOne.cookie), `注册状态 ${registered.status}`);

  const deviceTwo = new CookieJar();
  const loggedIn = await login(email, initialPassword, deviceTwo);
  assertCheck(checks, '设备二建立独立旧会话', loggedIn.status === 200 && Boolean(deviceTwo.cookie), `登录状态 ${loggedIn.status}`);

  const [changeOne, changeTwo] = await Promise.all([
    changePassword(deviceOne, initialPassword, passwordOne),
    changePassword(deviceTwo, initialPassword, passwordTwo)
  ]);
  const successful = [
    { index: 1, status: changeOne.status, jar: deviceOne, password: passwordOne },
    { index: 2, status: changeTwo.status, jar: deviceTwo, password: passwordTwo }
  ].filter((item) => item.status === 200);
  const failed = [
    { index: 1, status: changeOne.status, jar: deviceOne },
    { index: 2, status: changeTwo.status, jar: deviceTwo }
  ].filter((item) => item.status !== 200);

  assertCheck(checks, '并发请求仅一台设备成功改密', successful.length === 1 && failed.length === 1, `设备一=${changeOne.status}, 设备二=${changeTwo.status}`);
  if (successful.length !== 1) throw new Error('无法确定唯一成功设备');

  const winner = successful[0];
  const loser = failed[0];
  assertCheck(checks, '失败设备按冲突/失效口径拒绝', [401, 409, 422].includes(loser.status), `失败状态 ${loser.status}`);
  assertCheck(checks, '成功设备新会话仍有效', (await me(winner.jar)).status === 200, 'GET /auth/me');
  assertCheck(checks, '失败设备旧会话已失效', (await me(loser.jar)).status === 401, 'GET /auth/me');

  const winnerLogin = new CookieJar();
  const loserLogin = new CookieJar();
  const winnerPasswordResult = await login(email, winner.password, winnerLogin);
  const loserPasswordResult = await login(email, winner.index === 1 ? passwordTwo : passwordOne, loserLogin);
  assertCheck(checks, '最终活动密码与成功设备一致', winnerPasswordResult.status === 200, `成功设备新密码登录 ${winnerPasswordResult.status}`);
  assertCheck(checks, '未胜出密码不能登录', loserPasswordResult.status === 401, `另一新密码登录 ${loserPasswordResult.status}`);

  const beforeRetry = await timeline(winner.jar);
  assertCheck(checks, '并发改密仅产生一条审计', beforeRetry.status === 200 && beforeRetry.data?.pagination?.total === 1, `PASSWORD_CHANGED 总数 ${beforeRetry.data?.pagination?.total}`);

  const retry = await changePassword(loser.jar, initialPassword, retryPassword);
  assertCheck(checks, '旧设备重试不能再次轮换', retry.status !== 200, `重试状态 ${retry.status}`);
  const afterRetry = await timeline(winner.jar);
  assertCheck(checks, '重试失败不追加审计', afterRetry.status === 200 && afterRetry.data?.pagination?.total === 1, `重试后 PASSWORD_CHANGED 总数 ${afterRetry.data?.pagination?.total}`);

  const retryLogin = new CookieJar();
  const retryPasswordResult = await login(email, retryPassword, retryLogin);
  assertCheck(checks, '旧设备重试的新密码不可用', retryPasswordResult.status === 401, `重试新密码登录 ${retryPasswordResult.status}`);

  const passed = checks.every((check) => check.ok);
  summary = passed
    ? `冲突仲裁只允许一个事务完成；密码、会话与审计原子一致，旧设备 ${loser.status} 失败后重试仍为 ${retry.status}，审计保持 1 条。`
    : '至少一项不变量未满足，详见下方检查记录。';
  await writeReport(checks, summary);
  console.log(`\n[repro ${variant}] ${passed ? 'PASS' : 'FAIL'}: ${summary}`);
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  if (!passed) process.exitCode = 1;
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  checks.push({ name: '验证流程执行完成', ok: false, detail });
  await writeReport(checks, `验证中止：${detail}`);
  console.error(`[repro ${variant}] FAIL: ${detail}`);
  process.exitCode = 1;
}
NODE
